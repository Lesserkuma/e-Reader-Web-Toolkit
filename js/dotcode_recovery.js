(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./dotcode_layout.js"),
      require("./dotcode_math.js"),
      require("./reed_solomon.js"),
      require("./raw_codec.js"),
      require("./dotcode_sampling.js"),
    );
  } else {
    root.EReaderDotcodeRecovery = factory(
      root.EReaderDotcodeLayout,
      root.EReaderDotcodeMath,
      root.EReaderReedSolomon,
      root.EReaderRawCodec,
      root.EReaderDotcodeSampling,
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (layout, math, rs, rawModule, sampling) {
  "use strict";

  const { BYTES_PER_BLOCK, BITS_PER_BLOCK, MODULATION_TABLE } = layout;
  const codec = rawModule.createRawCodec();
  const PHASE_THRESHOLDS = Array.from({ length: 71 }, (_, i) => 180 + i * 0.5);
  const MAX_SAMPLER_PIXELS = 8_000_000;

  const { dot } = math;
  const SIGMAS = Object.freeze([0.5, 0.65, 0.8, 0.95]);
  const SUPPORT = 3.5 * SIGMAS[SIGMAS.length - 1];
  const positions = Array.from({ length: layout.BITS_PER_BLOCK }, (_, index) =>
    layout.dataPosition(index),
  );
  const modelPositions = [];
  const modelIndex = new Map();
  for (let y = 4; y < 40; y++) {
    for (let x = 4; x < 40; x++) {
      if ([4, 39].some((cx) => [4, 39].some((cy) => (x - cx) ** 2 + (y - cy) ** 2 <= 16)))
        continue;
      modelIndex.set(y * 44 + x, modelPositions.length);
      modelPositions.push([x, y]);
    }
  }
  const dataIndices = Uint16Array.from(positions, ([x, y]) => modelIndex.get(y * 44 + x));

  const BASE_COUNT = 50;
  const PHASE_COUNT = 5;
  const FEATURE_COUNT = 1 + BASE_COUNT * PHASE_COUNT;
  const MOMENT_COUNT = 13;
  const PAIR_COUNT = (BASE_COUNT * (BASE_COUNT + 1)) / 2;
  const OFFSETS = Object.freeze([-1.2, -0.6, 0, 0.6, 1.2]);

  function physicalHeader(blockCount) {
    const long = blockCount === layout.LONG_BLOCK_COUNT;
    return Uint8Array.from([0, long ? 3 : 2, 0, long ? 25 : 1, 64, 16, 0, long ? 44 : 28]);
  }

  function filterLine(values, start, stride, length, upper, work) {
    if (length < 2) return;
    upper[0] = 0.5;
    work[0] = values[start] * 1.5;
    for (let index = 1; index < length; index++) {
      const lower = index === length - 1 ? 2 : 1;
      const diagonal = 4 - lower * upper[index - 1];
      upper[index] = index === length - 1 ? 0 : 1 / diagonal;
      work[index] = (6 * values[start + index * stride] - lower * work[index - 1]) / diagonal;
    }
    values[start + (length - 1) * stride] = work[length - 1];
    for (let index = length - 2; index >= 0; index--)
      values[start + index * stride] = work[index] - upper[index] * values[start + (index + 1) * stride];
  }

  function channelCoefficients(state, channel) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 3)
      throw new RangeError("Invalid scan color channel");
    if (state.channels[channel]) return state.channels[channel];
    const { image, width, height } = state;
    const values = new Float64Array(width * height);
    for (let index = 0; index < values.length; index++)
      values[index] = image.data[image.redOnly ? index : index * 4 + channel];
    const upper = new Float64Array(Math.max(width, height));
    const work = new Float64Array(upper.length);
    for (let x = 0; x < width; x++) filterLine(values, x, width, height, upper, work);
    for (let y = 0; y < height; y++) filterLine(values, y * width, 1, width, upper, work);
    state.channels[channel] = values;
    return values;
  }

  function mirror(index, length) {
    if (length === 1) return 0;
    if (index >= 0 && index < length) return index;
    const period = 2 * length - 2;
    const folded = ((index % period) + period) % period;
    return folded < length ? folded : period - folded;
  }

  function splineWeights(t, values, derivatives) {
    const complement = 1 - t;
    values[0] = (complement * complement * complement) / 6;
    values[1] = (3 * t * t * t - 6 * t * t + 4) / 6;
    values[2] = (-3 * t * t * t + 3 * t * t + 3 * t + 1) / 6;
    values[3] = (t * t * t) / 6;
    if (derivatives) {
      derivatives[0] = -0.5 * complement * complement;
      derivatives[1] = 1.5 * t * t - 2 * t;
      derivatives[2] = -1.5 * t * t + t + 0.5;
      derivatives[3] = 0.5 * t * t;
    }
  }

  function interpolate(state, x, y, channel, gradient) {
    if (x < 0 || y < 0 || x > state.width - 1 || y > state.height - 1) {
      if (gradient) gradient.fill(0);
      return 0;
    }
    const coefficients = channelCoefficients(state, channel);
    const ix = Math.floor(x),
      iy = Math.floor(y);
    splineWeights(x - ix, state.wx, gradient ? state.dx : null);
    splineWeights(y - iy, state.wy, gradient ? state.dy : null);
    let value = 0,
      gx = 0,
      gy = 0;
    for (let row = 0; row < 4; row++) {
      const base = mirror(iy + row - 1, state.height) * state.width;
      let horizontal = 0,
        derivative = 0;
      for (let column = 0; column < 4; column++) {
        const coefficient = coefficients[base + mirror(ix + column - 1, state.width)];
        horizontal += coefficient * state.wx[column];
        if (gradient) derivative += coefficient * state.dx[column];
      }
      value += horizontal * state.wy[row];
      if (gradient) {
        gx += derivative * state.wy[row];
        gy += horizontal * state.dy[row];
      }
    }
    if (gradient) {
      gradient[0] = gx;
      gradient[1] = gy;
    }
    return value;
  }

  function createSampler(image) {
    if (
      !image ||
      !Number.isInteger(image.width) ||
      !Number.isInteger(image.height) ||
      image.width < 1 ||
      image.height < 1 ||
      !image.data ||
      image.data.length < image.width * image.height * (image.redOnly ? 1 : 4)
    )
      throw new TypeError("Invalid scan image");
    return {
      image,
      width: image.width,
      height: image.height,
      channels: [],
      wx: new Float64Array(4),
      wy: new Float64Array(4),
      dx: new Float64Array(4),
      dy: new Float64Array(4),
    };
  }

  function coordinates(top, bottom, block, logical, shift) {
    const result = new Float64Array(logical.length * 2);
    for (let index = 0; index < logical.length; index++) {
      const [x, y] = logical[index];
      const u = (x - 4) / 35,
        v = (y - 4) / 35;
      for (let axis = 0; axis < 2; axis++) {
        const name = axis ? "y" : "x";
        result[index * 2 + axis] =
          top[block][name] * (1 - u) * (1 - v) +
          top[block + 1][name] * u * (1 - v) +
          bottom[block][name] * (1 - u) * v +
          bottom[block + 1][name] * u * v +
          (shift
            ? shift[axis] + ((x - 21.5) / 35) * shift[axis + 2] + ((y - 21.5) / 35) * shift[axis + 4]
            : 0);
      }
    }
    return result;
  }

  function checkGrid(top, bottom) {
    const count = top.length - 1;
    if (
      (count !== layout.LONG_BLOCK_COUNT && count !== layout.SHORT_BLOCK_COUNT) ||
      bottom.length !== top.length ||
      [...top, ...bottom].some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
    )
      throw new TypeError("Invalid dotcode marker grid");
    return count;
  }

  function minimizeBounded(evaluate) {
    let point = new Float64Array(6),
      current = evaluate(point);
    let inverse = Float64Array.from({ length: 36 }, (_, index) => (index % 7 === 0 ? 0.05 : 0));
    for (let iteration = 0; iteration < 150; iteration++) {
      const projected = Float64Array.from(current.gradient, (value, index) =>
        (point[index] <= -0.8 && value > 0) || (point[index] >= 0.8 && value < 0) ? 0 : value,
      );
      if (Math.max(...projected.map(Math.abs)) <= 0.000005) break;
      const direction = new Float64Array(6);
      for (let row = 0; row < 6; row++) {
        for (let column = 0; column < 6; column++)
          direction[row] -= inverse[row * 6 + column] * projected[column];
        if ((point[row] <= -0.8 && direction[row] < 0) || (point[row] >= 0.8 && direction[row] > 0))
          direction[row] = 0;
      }
      if (dot(direction, current.gradient) >= -1e-12)
        for (let index = 0; index < 6; index++) direction[index] = -projected[index] * 0.02;
      let step = 1,
        next,
        candidate,
        delta;
      for (let search = 0; search < 32; search++) {
        candidate = Float64Array.from(point, (value, index) =>
          Math.max(-0.8, Math.min(0.8, value + step * direction[index])),
        );
        delta = Float64Array.from(candidate, (value, index) => value - point[index]);
        next = evaluate(candidate);
        if (next.value <= current.value + 0.0001 * dot(current.gradient, delta)) break;
        next = null;
        step *= 0.5;
      }
      if (!next) break;
      const change = Float64Array.from(
        next.gradient,
        (value, index) => value - current.gradient[index],
      );
      const curvature = dot(delta, change);
      if (curvature > 1e-12) {
        const product = new Float64Array(6);
        for (let row = 0; row < 6; row++)
          for (let column = 0; column < 6; column++)
            product[row] += inverse[row * 6 + column] * change[column];
        const scale = (curvature + dot(change, product)) / (curvature * curvature);
        for (let row = 0; row < 6; row++)
          for (let column = 0; column < 6; column++)
            inverse[row * 6 + column] +=
              scale * delta[row] * delta[column] -
              (product[row] * delta[column] + delta[row] * product[column]) / curvature;
      }
      const improvement = current.value - next.value;
      point = candidate;
      current = next;
      if (improvement >= 0 && improvement < 1e-12) break;
    }
    return point;
  }

  function calibrateGrid(state, top, bottom) {
    const count = checkGrid(top, bottom);
    const header = rs.encodeCodeword(physicalHeader(count));
    const timing = [],
      timingLabels = [];
    for (const y of [4, 39]) {
      for (let x = 9; x < 36; x++) {
        timing.push([x, y]);
        timingLabels.push(
          Number((x >= 10 && x <= 20 && x % 2 === 0) || (x >= 23 && x <= 33 && x % 2 === 1)),
        );
      }
    }
    const calibration = [...timing, ...positions.slice(0, 20)];
    const samples = [],
      points = [],
      shifts = [];
    for (let block = 0; block < count; block++) {
      const labels = timingLabels.slice();
      for (let byte = 0; byte < 2; byte++) {
        const value = header[(block % 12) * 2 + byte];
        for (const nibble of [value >>> 4, value & 15])
          for (let bit = 4; bit >= 0; bit--) labels.push((layout.MODULATION_TABLE[nibble] >>> bit) & 1);
      }
      const dark = labels.reduce((sum, value) => sum + value, 0);
      const weights = labels.map((value) => (value ? -1 / dark : 1 / (labels.length - dark)));
      const initial = coordinates(top, bottom, block, calibration);
      const gradient = new Float64Array(2);
      const evaluate = (shift) => {
        let value = 4 * dot(shift, shift);
        const result = Float64Array.from(shift, (entry) => 8 * entry);
        for (let index = 0; index < calibration.length; index++) {
          const bx = (calibration[index][0] - 21.5) / 35,
            by = (calibration[index][1] - 21.5) / 35;
          const x = initial[index * 2] + shift[0] + bx * shift[2] + by * shift[4],
            y = initial[index * 2 + 1] + shift[1] + bx * shift[3] + by * shift[5];
          value -= weights[index] * interpolate(state, x, y, 0, gradient);
          for (let axis = 0; axis < 2; axis++) {
            const change = weights[index] * gradient[axis];
            result[axis] -= change;
            result[axis + 2] -= bx * change;
            result[axis + 4] -= by * change;
          }
        }
        return { value, gradient: result };
      };
      const shift = minimizeBounded(evaluate);
      const xy = coordinates(top, bottom, block, positions, shift);
      shifts.push(shift);
      points.push(xy);
      samples.push(
        Float64Array.from({ length: layout.BITS_PER_BLOCK }, (_, index) =>
          interpolate(state, xy[index * 2], xy[index * 2 + 1], 0),
        ),
      );
    }
    return { samples, points, shifts };
  }

  function prepareBlock(state, xy, corners) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    const buckets = new Map();
    for (let index = 0; index < xy.length / 2; index++) {
      const x = xy[index * 2],
        y = xy[index * 2 + 1];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const key = `${Math.floor(x / SUPPORT)},${Math.floor(y / SUPPORT)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(index);
    }
    const pixelsX = [],
      pixelsY = [],
      target = [],
      columns = [],
      distances = [],
      starts = [0];
    const left = Math.max(0, Math.floor(minX - 1)),
      right = Math.min(state.width - 1, Math.ceil(maxX + 1)),
      upper = Math.max(0, Math.floor(minY - 1)),
      lower = Math.min(state.height - 1, Math.ceil(maxY + 1));
    for (let y = upper; y <= lower; y++) {
      for (let x = left; x <= right; x++) {
        if (corners.some((point) => (point.x - x) ** 2 + (point.y - y) ** 2 <= 7.4 ** 2))
          continue;
        pixelsX.push(x);
        pixelsY.push(y);
        const pixelIndex = y * state.width + x;
        target.push(255 - state.image.data[state.image.redOnly ? pixelIndex : pixelIndex * 4]);
        const candidates = [],
          bx = Math.floor(x / SUPPORT),
          by = Math.floor(y / SUPPORT);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const column of buckets.get(`${bx + dx},${by + dy}`) || []) {
              const distance = (x - xy[column * 2]) ** 2 + (y - xy[column * 2 + 1]) ** 2;
              if (distance <= SUPPORT ** 2) candidates.push([column, distance]);
            }
          }
        }
        candidates.sort((a, b) => a[0] - b[0]);
        for (const [column, distance] of candidates) {
          columns.push(column);
          distances.push(distance);
        }
        starts.push(columns.length);
      }
    }
    const meanX = pixelsX.reduce((sum, value) => sum + value, 0) / pixelsX.length,
      meanY = pixelsY.reduce((sum, value) => sum + value, 0) / pixelsY.length;
    return {
      starts: Uint32Array.from(starts),
      columns: Uint16Array.from(columns),
      distances: Float64Array.from(distances),
      bx: Float64Array.from(pixelsX, (value) => (value - meanX) / 60),
      by: Float64Array.from(pixelsY, (value) => (value - meanY) / 60),
      target: Float64Array.from(target),
      size: xy.length / 2 + 3,
    };
  }

  function operator(prepared, sigma) {
    const { starts, columns, distances, bx, by, size } = prepared;
    const values = Float64Array.from(distances, (distance) =>
      distance <= (3.5 * sigma) ** 2 ? Math.exp(-distance / (2 * sigma * sigma)) : 0,
    );
    return {
      size,
      multiply(input, output) {
        for (let row = 0; row < bx.length; row++) {
          let value = 0;
          for (let index = starts[row]; index < starts[row + 1]; index++)
            value += values[index] * input[columns[index]];
          output[row] = value + input[size - 3] + bx[row] * input[size - 2] + by[row] * input[size - 1];
        }
      },
      transpose(input, output) {
        output.fill(0);
        for (let row = 0; row < bx.length; row++) {
          const value = input[row];
          for (let index = starts[row]; index < starts[row + 1]; index++)
            output[columns[index]] += values[index] * value;
          output[size - 3] += value;
          output[size - 2] += bx[row] * value;
          output[size - 1] += by[row] * value;
        }
      },
    };
  }

  function normalize(vector) {
    const norm = Math.sqrt(dot(vector, vector));
    if (norm > 0) for (let index = 0; index < vector.length; index++) vector[index] /= norm;
    return norm;
  }

  function lsqr(matrix, target) {
    const damp = 0.08;
    const solution = new Float64Array(matrix.size),
      u = target.slice(),
      v = new Float64Array(matrix.size),
      nextU = new Float64Array(target.length),
      nextV = new Float64Array(matrix.size);
    const bnorm = normalize(u);
    matrix.transpose(u, v);
    let alpha = normalize(v),
      beta = bnorm;
    const w = v.slice();
    let rhobar = alpha,
      phibar = beta,
      anorm = 0,
      ddnorm = 0,
      residualSquared = 0,
      xxnorm = 0,
      z = 0,
      cs2 = -1,
      sn2 = 0;
    if (alpha * beta === 0) return solution;
    for (let iteration = 0; iteration < 150; iteration++) {
      matrix.multiply(v, nextU);
      for (let index = 0; index < u.length; index++) u[index] = nextU[index] - alpha * u[index];
      beta = normalize(u);
      if (beta > 0) {
        anorm = Math.sqrt(anorm * anorm + alpha * alpha + beta * beta + damp * damp);
        matrix.transpose(u, nextV);
        for (let index = 0; index < v.length; index++) v[index] = nextV[index] - beta * v[index];
        alpha = normalize(v);
      }
      const rhobar1 = Math.hypot(rhobar, damp),
        psi = (damp / rhobar1) * phibar;
      phibar *= rhobar / rhobar1;
      const rho = Math.hypot(rhobar1, beta),
        cs = rhobar1 / rho,
        sn = beta / rho,
        theta = sn * alpha,
        phi = cs * phibar,
        tau = sn * phi;
      rhobar = -cs * alpha;
      phibar *= sn;
      for (let index = 0; index < w.length; index++) {
        const old = w[index];
        solution[index] += (phi / rho) * old;
        w[index] = v[index] - (theta / rho) * old;
        ddnorm += (old / rho) ** 2;
      }
      const delta = sn2 * rho,
        gambar = -cs2 * rho,
        rhs = phi - delta * z,
        zbar = rhs / gambar,
        xnorm = Math.sqrt(xxnorm + zbar * zbar),
        gamma = Math.hypot(gambar, theta);
      cs2 = gambar / gamma;
      sn2 = theta / gamma;
      z = rhs / gamma;
      xxnorm += z * z;
      residualSquared += psi * psi;
      const rnorm = Math.sqrt(phibar * phibar + residualSquared),
        arnorm = alpha * Math.abs(tau),
        acond = anorm * Math.sqrt(ddnorm),
        relative = rnorm / bnorm,
        normalResidual = arnorm / (anorm * rnorm + Number.EPSILON),
        tolerance = 0.00001 + (0.00001 * anorm * xnorm) / bnorm;
      if (relative <= tolerance || normalResidual <= 0.00001 || acond >= 1e8) break;
    }
    return solution;
  }

  function normalizeAmplitudes(blocks) {
    const ordered = Float64Array.from(blocks.flatMap((block) => Array.from(block))).sort();
    const percentile = (fraction) => {
      const at = fraction * (ordered.length - 1),
        lower = Math.floor(at);
      return ordered[lower] + (ordered[Math.ceil(at)] - ordered[lower]) * (at - lower);
    };
    let low = percentile(0.2),
      high = percentile(0.85);
    for (let iteration = 0; iteration < 15; iteration++) {
      let light = 0,
        dark = 0,
        lightCount = 0,
        darkCount = 0;
      for (const block of blocks) {
        for (const value of block) {
          if (Math.abs(value - low) > Math.abs(value - high)) {
            dark += value;
            darkCount++;
          } else {
            light += value;
            lightCount++;
          }
        }
      }
      if (!darkCount || !lightCount) throw new Error("Insufficient dot contrast");
      low = light / lightCount;
      high = dark / darkCount;
    }
    if (!(high > low) || !Number.isFinite(high - low)) throw new Error("Invalid dot amplitudes");
    return blocks.map((block) => Float64Array.from(block, (value) => -(value - low) / (high - low)));
  }

  function inverseSources(state, top, bottom, phase) {
    const count = checkGrid(top, bottom);
    if (!phase || phase.shifts.length !== count) throw new TypeError("Invalid scan calibration");
    const amplitudes = SIGMAS.map(() => []);
    for (let block = 0; block < count; block++) {
      const xy = coordinates(top, bottom, block, modelPositions, phase.shifts[block]);
      const prepared = prepareBlock(state, xy, [
        top[block], top[block + 1], bottom[block], bottom[block + 1],
      ]);
      for (let variant = 0; variant < SIGMAS.length; variant++) {
        const solution = lsqr(operator(prepared, SIGMAS[variant]), prepared.target);
        amplitudes[variant].push(Float64Array.from(dataIndices, (index) => solution[index]));
      }
    }
    return amplitudes.map((blocks) => ({
      samples: normalizeAmplitudes(blocks),
      thresholds: Array.from({ length: 31 }, (_, index) => -0.8 + index * 0.02),
    }));
  }

  function createTrainingSums() {
    return {
      count: 0,
      moments: new Float64Array(PAIR_COUNT * MOMENT_COUNT),
      first: new Float64Array(FEATURE_COUNT),
      target: new Float64Array(FEATURE_COUNT),
    };
  }

  function accumulateTrainingSample(sums, bases, baseOffset, phases, phaseOffset, label) {
    sums.count++;
    const sx = phases[phaseOffset + 1];
    const cx = phases[phaseOffset + 2];
    const sy = phases[phaseOffset + 3];
    const cy = phases[phaseOffset + 4];
    const sxx = sx * sx;
    const sxcx = sx * cx;
    const syy = sy * sy;
    const sycy = sy * cy;
    const sxsy = sx * sy;
    const sxcy = sx * cy;
    const cxsy = cx * sy;
    const cxcy = cx * cy;
    const moments = sums.moments;
    let at = 0;
    for (let row = 0; row < BASE_COUNT; row++) {
      const left = bases[baseOffset + row];
      for (let column = 0; column <= row; column++, at += MOMENT_COUNT) {
        const product = left * bases[baseOffset + column];
        moments[at] += product;
        moments[at + 1] += product * sx;
        moments[at + 2] += product * cx;
        moments[at + 3] += product * sy;
        moments[at + 4] += product * cy;
        moments[at + 5] += product * sxx;
        moments[at + 6] += product * sxcx;
        moments[at + 7] += product * syy;
        moments[at + 8] += product * sycy;
        moments[at + 9] += product * sxsy;
        moments[at + 10] += product * sxcy;
        moments[at + 11] += product * cxsy;
        moments[at + 12] += product * cxcy;
      }
    }
    sums.first[0]++;
    sums.target[0] += label;
    for (let phase = 0; phase < PHASE_COUNT; phase++) {
      const multiplier = phases[phaseOffset + phase];
      const start = 1 + phase * BASE_COUNT;
      for (let base = 0; base < BASE_COUNT; base++) {
        const value = bases[baseOffset + base] * multiplier;
        sums.first[start + base] += value;
        sums.target[start + base] += value * label;
      }
    }
  }

  function phaseMoment(moments, at, row, column) {
    if (column === 0) return moments[at + row];
    if (row === 1) return moments[at + 5];
    if (row === 2) return column === 1 ? moments[at + 6] : moments[at] - moments[at + 5];
    if (row === 3) {
      if (column === 1) return moments[at + 9];
      return moments[at + (column === 2 ? 11 : 7)];
    }
    if (column === 1) return moments[at + 10];
    if (column === 2) return moments[at + 12];
    return column === 3 ? moments[at + 8] : moments[at] - moments[at + 7];
  }

  function fitFilter(sums) {
    if (!sums.count) throw new Error("No corrected data bits are available for filter training.");
    const matrix = Array.from({ length: FEATURE_COUNT }, () => new Float64Array(FEATURE_COUNT));
    for (let row = 0; row < FEATURE_COUNT; row++) {
      matrix[row][0] = matrix[0][row] = sums.first[row];
    }
    // Products of the phase factors reuse thirteen symmetric matrices of base samples.
    for (let phaseRow = 0; phaseRow < PHASE_COUNT; phaseRow++) {
      for (let phaseColumn = 0; phaseColumn <= phaseRow; phaseColumn++) {
        for (let baseRow = 0; baseRow < BASE_COUNT; baseRow++) {
          const row = 1 + phaseRow * BASE_COUNT + baseRow;
          for (let baseColumn = 0; baseColumn < BASE_COUNT; baseColumn++) {
            const column = 1 + phaseColumn * BASE_COUNT + baseColumn;
            if (column > row) continue;
            const upper = Math.max(baseRow, baseColumn);
            const lower = Math.min(baseRow, baseColumn);
            const at = ((upper * (upper + 1)) / 2 + lower) * MOMENT_COUNT;
            const value = phaseMoment(sums.moments, at, phaseRow, phaseColumn);
            matrix[row][column] = matrix[column][row] = value;
          }
        }
      }
    }
    const regularization = sums.count * 0.0003;
    for (let row = 0; row < FEATURE_COUNT; row++) matrix[row][row] += regularization;
    const factor = math.factorSymmetric(matrix);
    if (!factor) throw new Error("The dot filter training matrix could not be factored.");
    return math.solveFactored(factor, sums.target);
  }

  function predictDot(weights, bases, phases, point) {
    let value = weights[0];
    const baseOffset = point * BASE_COUNT;
    const phaseOffset = point * PHASE_COUNT;
    for (let phase = 0; phase < PHASE_COUNT; phase++) {
      let sum = 0;
      const start = 1 + phase * BASE_COUNT;
      for (let base = 0; base < BASE_COUNT; base++) sum += weights[start + base] * bases[baseOffset + base];
      value += sum * phases[phaseOffset + phase];
    }
    return value;
  }

  function trainFilter(sampler, phase, knownColumns, blockCount) {
    if (blockCount !== layout.LONG_BLOCK_COUNT && blockCount !== layout.SHORT_BLOCK_COUNT) {
      throw new Error("Unsupported dotcode strip length for filter training.");
    }
    if (!phase || !Array.isArray(phase.points) || phase.points.length !== blockCount) {
      throw new Error("Missing calibrated dot coordinates for filter training.");
    }
    const columnCount = blockCount === layout.LONG_BLOCK_COUNT ? 44 : 28;
    const bytes = new Int16Array(blockCount * layout.BYTES_PER_BLOCK).fill(-1);
    const columns = new Set();
    for (const entry of knownColumns) {
      if (
        !Number.isInteger(entry.column) || entry.column < 0 || entry.column >= columnCount ||
        !entry.word || entry.word.length !== 64 || columns.has(entry.column)
      ) {
        throw new Error("Invalid corrected codeword for filter training.");
      }
      columns.add(entry.column);
      for (let row = 0; row < 64; row++) {
        const dataOffset = row * columnCount + entry.column;
        const rawOffset = Math.floor(dataOffset / 102) * layout.BYTES_PER_BLOCK + 2 + dataOffset % 102;
        bytes[rawOffset] = entry.word[row];
      }
    }

    const pointCount = blockCount * layout.BITS_PER_BLOCK;
    const bases = new Float64Array(pointCount * BASE_COUNT);
    const phases = new Float64Array(pointCount * PHASE_COUNT);
    const training = createTrainingSums();
    const reservedTraining = createTrainingSums();
    for (let block = 0; block < blockCount; block++) {
      const coordinates = phase.points[block];
      if (!coordinates || coordinates.length !== layout.BITS_PER_BLOCK * 2) {
        throw new Error("Invalid calibrated dot coordinates for filter training.");
      }
      for (let bit = 0; bit < layout.BITS_PER_BLOCK; bit++) {
        const point = block * layout.BITS_PER_BLOCK + bit;
        const baseOffset = point * BASE_COUNT;
        const phaseOffset = point * PHASE_COUNT;
        const x = coordinates[bit * 2];
        const y = coordinates[bit * 2 + 1];
        let feature = baseOffset;
        for (let channel = 0; channel < 2; channel++) {
          for (const dy of OFFSETS) {
            for (const dx of OFFSETS) {
              bases[feature++] = (interpolate(sampler, x + dx, y + dy, channel) - 180) / 60;
            }
          }
        }
        phases[phaseOffset] = 1;
        phases[phaseOffset + 1] = Math.sin(2 * Math.PI * x);
        phases[phaseOffset + 2] = Math.cos(2 * Math.PI * x);
        phases[phaseOffset + 3] = Math.sin(2 * Math.PI * y);
        phases[phaseOffset + 4] = Math.cos(2 * Math.PI * y);
        const byteOffset = Math.floor(point / 10);
        const byte = bytes[byteOffset];
        if (byte < 0) continue;
        const nibble = bit % 10 < 5 ? byte >>> 4 : byte & 15;
        const label = (layout.MODULATION_TABLE[nibble] >>> (4 - bit % 5)) & 1;
        accumulateTrainingSample(
          byteOffset % 7 === 0 ? reservedTraining : training,
          bases,
          baseOffset,
          phases,
          phaseOffset,
          label,
        );
      }
    }

    // Accumulate reserved samples separately to preserve floating-point summation order.
    training.count += reservedTraining.count;
    for (let index = 0; index < training.moments.length; index++) {
      training.moments[index] += reservedTraining.moments[index];
    }
    for (let index = 0; index < FEATURE_COUNT; index++) {
      training.first[index] += reservedTraining.first[index];
      training.target[index] += reservedTraining.target[index];
    }
    const weights = fitFilter(training);
    const samples = Array.from({ length: blockCount }, () => new Float64Array(layout.BITS_PER_BLOCK));
    for (let point = 0; point < pointCount; point++) {
      const block = Math.floor(point / layout.BITS_PER_BLOCK);
      samples[block][point % layout.BITS_PER_BLOCK] = -predictDot(weights, bases, phases, point);
    }
    return {
      samples,
      thresholds: Array.from({ length: 21 }, (_, index) => -0.7 + index * 0.02),
    };
  }

  function demodulate(samples, threshold) {
    const raw = new Uint8Array(samples.length * BYTES_PER_BLOCK);
    const costs = new Float64Array(32);
    for (let block = 0; block < samples.length; block++) {
      for (let symbol = 0; symbol < BYTES_PER_BLOCK * 2; symbol++) {
        costs[0] = 0;
        for (let bit = 0; bit < 5; bit++) {
          const value = samples[block][symbol * 5 + 4 - bit] - threshold;
          const count = 1 << bit;
          for (let code = 0; code < count; code++) costs[count + code] = costs[code] + value;
        }
        let best = 0;
        for (let nibble = 1; nibble < 16; nibble++) {
          if (costs[MODULATION_TABLE[nibble]] < costs[MODULATION_TABLE[best]]) best = nibble;
        }
        raw[block * BYTES_PER_BLOCK + (symbol >>> 1)] |= best << (symbol % 2 ? 0 : 4);
      }
    }
    return raw;
  }

  function wordKey(word) {
    return String.fromCharCode(...word);
  }

  function createCollector(blockCount) {
    const columns = blockCount === layout.LONG_BLOCK_COUNT ? 44 : 28;
    const expectedHeader = physicalHeader(blockCount);
    const seen = Array.from({ length: columns }, () => new Set());
    const accepted = Array.from({ length: columns }, () => new Map());
    let acceptedHeader = null;
    function add(source) {
      if (
        source.samples.length !== blockCount || source.samples.some((row) =>
          row.length !== BITS_PER_BLOCK || row.some((value) => !Number.isFinite(value)),
        )
      ) {
        throw new Error("Invalid point reconstruction");
      }
      for (const threshold of source.thresholds || PHASE_THRESHOLDS) {
        const raw = demodulate(source.samples, threshold);
        const header = new Uint8Array(24);
        for (let block = 0; block < 12; block++) {
          header.set(raw.subarray(block * BYTES_PER_BLOCK, block * BYTES_PER_BLOCK + 2), block * 2);
        }
        try {
          const corrected = rs.correctStoredCodeword(header).data;
          if (expectedHeader.every((value, i) => value === corrected[i])) {
            acceptedHeader = corrected;
          }
        } catch (error) {
          if (!(error instanceof rs.ReedSolomonError)) throw error;
        }
        const words = layout.deinterleave(layout.readBlockData(raw, columns * 64), columns, 64);
        for (let column = 0; column < columns; column++) {
          const word = words.subarray(column * 64, column * 64 + 64);
          const key = wordKey(word);
          if (seen[column].has(key)) continue;
          seen[column].add(key);
          try {
            const corrected = rs.correctStoredCodeword(word).data;
            accepted[column].set(wordKey(corrected), corrected);
          } catch (error) {
            if (!(error instanceof rs.ReedSolomonError)) throw error;
          }
        }
      }
    }
    function known() {
      return accepted.flatMap((words, column) =>
        words.size === 1 ? [{ column, word: words.values().next().value }] : [],
      );
    }
    function finish(samples) {
      if (!acceptedHeader || accepted.some(words => words.size !== 1)) return null;
      const raw = demodulate(samples, -0.5);
      const header = acceptedHeader;
      for (let block = 0; block < blockCount; block++) {
        raw.set(header.subarray((block * 2) % 24, (block * 2) % 24 + 2), block * BYTES_PER_BLOCK);
      }
      const words = new Uint8Array(columns * 64);
      for (let column = 0; column < columns; column++) {
        const word = accepted[column].values().next().value;
        words.set(word, column * 64);
      }
      layout.writeBlockData(raw, layout.interleave(words, 64));
      codec.decodeRawDotcodeDetails(raw, "The reconstructed strip");
      return raw;
    }
    return { add, known, finish, columns };
  }

  function createSession(image) {
    let sampler;
    function samplingRegion(top, bottom) {
      if (image.width * image.height <= MAX_SAMPLER_PIXELS) {
        sampler ||= createSampler(image);
        return { sampler, top, bottom };
      }
      const markers = [...top, ...bottom];
      const left = Math.max(0, Math.floor(Math.min(...markers.map(p => p.x))) - 32);
      const upper = Math.max(0, Math.floor(Math.min(...markers.map(p => p.y))) - 32);
      const right = Math.min(image.width, Math.ceil(Math.max(...markers.map(p => p.x))) + 33);
      const lower = Math.min(image.height, Math.ceil(Math.max(...markers.map(p => p.y))) + 33);
      const width = right - left;
      const height = lower - upper;
      if (width <= 0 || height <= 0 || width * height > MAX_SAMPLER_PIXELS) return null;
      const stride = image.redOnly ? 1 : 4;
      const data = new Uint8Array(width * height * stride);
      for (let y = 0; y < height; y++) {
        const offset = ((upper + y) * image.width + left) * stride;
        data.set(image.data.subarray(offset, offset + width * stride), y * width * stride);
      }
      const translate = p => ({ x: p.x - left, y: p.y - upper });
      return {
        sampler: createSampler({ width, height, data, redOnly: image.redOnly }),
        top: top.map(translate),
        bottom: bottom.map(translate),
      };
    }
    function decode(top, bottom) {
      const region = samplingRegion(top, bottom);
      if (!region) return null;
      const blockCount = top.length - 1;
      const phase = calibrateGrid(region.sampler, region.top, region.bottom);
      const collector = createCollector(blockCount);
      collector.add(phase);
      for (const source of inverseSources(region.sampler, region.top, region.bottom, phase)) {
        collector.add(source);
      }
      let known = collector.known();
      if (known.length < Math.max(4, Math.ceil(collector.columns / 4))) return null;
      for (let round = 0; round < 2; round++) {
        const learned = trainFilter(region.sampler, phase, known, blockCount);
        collector.add(learned);
        const raw = collector.finish(learned.samples);
        if (raw) {
          const result = sampling.refineLowResolutionRaw(image, top, bottom, raw);
          codec.decodeRawDotcodeDetails(result.raw, "The reconstructed strip");
          return result;
        }
        const expanded = collector.known();
        if (expanded.length <= known.length) break;
        known = expanded;
      }
      return null;
    }
    return { decode };
  }

  return Object.freeze({ createSession });
});
