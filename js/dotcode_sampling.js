(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./dotcode_layout.js"),
      require("./dotcode_math.js"),
    );
  } else {
    root.EReaderDotcodeSampling = factory(
      root.EReaderDotcodeLayout,
      root.EReaderDotcodeMath,
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (layout, math) {
  "use strict";

  const { BYTES_PER_BLOCK, BITS_PER_BLOCK, MODULATION_TABLE } = layout;
  const MAX_CALIBRATION_ERROR_RATE = 0.025;
  const MIN_SYMBOL_MARGIN = 0.35;
  const PROFILE_OFFSETS = Object.freeze([-0.65, -0.325, 0, 0.325, 0.65]);
  const PROFILE_FEATURE_COUNT = PROFILE_OFFSETS.length ** 2;
  const PROFILE_CENTER = Math.floor(PROFILE_FEATURE_COUNT / 2);

  const SYMBOLS_PER_BLOCK = BYTES_PER_BLOCK * 2;
  const GRID_SIZE = 44;
  const INPUT_COUNT = 10;
  const SELF_INPUT = 5;
  const NEIGHBORS = Object.freeze(
    Array.from({ length: 9 }, (_, index) =>
      Object.freeze([(index % 3) - 1, Math.floor(index / 3) - 1]),
    ),
  );
  const SYMBOL_BITS = Object.freeze(
    MODULATION_TABLE.map((value) =>
      Object.freeze(Array.from({ length: 5 }, (_, bit) => (value >>> (4 - bit)) & 1)),
    ),
  );

  function redAt(image, x, y) {
    const index = y * image.width + x;
    return image.data[image.redOnly ? index : index * 4];
  }

  function sampleRed(image, x, y) {
    if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) return 255;
    const x0 = Math.floor(x),
      y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, image.width - 1),
      y1 = Math.min(y0 + 1, image.height - 1);
    const dx = x - x0,
      dy = y - y0;
    return (
      (redAt(image, x0, y0) * (1 - dx) + redAt(image, x1, y0) * dx) * (1 - dy) +
      (redAt(image, x0, y1) * (1 - dx) + redAt(image, x1, y1) * dx) * dy
    );
  }

  function quantile(histogram, count, fraction) {
    const rank = Math.floor((count - 1) * fraction);
    let cumulative = 0;
    for (let value = 0; value < 256; value++) {
      cumulative += histogram[value];
      if (cumulative > rank) return value;
    }
    return 255;
  }

  function refineMarker(image, point, pitch) {
    const radius = Math.max(3, Math.round(pitch * 3.25));
    let center = point;
    for (let iteration = 0; iteration < 4; iteration++) {
      const centerX = Math.round(center.x),
        centerY = Math.round(center.y);
      const left = Math.max(0, centerX - radius),
        right = Math.min(image.width - 1, centerX + radius);
      const top = Math.max(0, centerY - radius),
        bottom = Math.min(image.height - 1, centerY + radius);
      const histogram = new Uint32Array(256);
      for (let y = top; y <= bottom; y++)
        for (let x = left; x <= right; x++) histogram[redAt(image, x, y)]++;
      const count = (right - left + 1) * (bottom - top + 1);
      const dark = quantile(histogram, count, 0.1),
        light = quantile(histogram, count, 0.9);
      if (light - dark < 10) return point;
      const threshold = (dark + light) / 2;
      let sumX = 0,
        sumY = 0,
        weight = 0;
      for (let y = top; y <= bottom; y++)
        for (let x = left; x <= right; x++) {
          const darkness = Math.max(0, threshold - redAt(image, x, y));
          sumX += (x - centerX) * darkness;
          sumY += (y - centerY) * darkness;
          weight += darkness;
        }
      if (weight === 0) return point;
      center = { x: centerX + sumX / weight, y: centerY + sumY / weight };
      if (Math.round(center.x) === centerX && Math.round(center.y) === centerY) break;
    }
    return Math.hypot(center.x - point.x, center.y - point.y) <= pitch ? center : point;
  }

  function gridPosition(top, bottom, block, x, y) {
    const u = (x - 4) / 35,
      v = (y - 4) / 35;
    // Local deltas reduce interpolation rounding differences after integer translations.
    const origin = top[block];
    return {
      x:
        origin.x +
        (top[block + 1].x - origin.x) * u * (1 - v) +
        (bottom[block].x - origin.x) * (1 - u) * v +
        (bottom[block + 1].x - origin.x) * u * v,
      y:
        origin.y +
        (top[block + 1].y - origin.y) * u * (1 - v) +
        (bottom[block].y - origin.y) * (1 - u) * v +
        (bottom[block + 1].y - origin.y) * u * v,
    };
  }

  function blockGeometry(top, bottom, block) {
    const x = new Float64Array(BITS_PER_BLOCK),
      y = new Float64Array(BITS_PER_BLOCK);
    for (let i = 0; i < BITS_PER_BLOCK; i++) {
      const [logicalX, logicalY] = layout.dataPosition(i);
      const position = gridPosition(top, bottom, block, logicalX, logicalY);
      x[i] = position.x;
      y[i] = position.y;
    }
    return {
      x,
      y,
      xx: (top[block + 1].x - top[block].x + bottom[block + 1].x - bottom[block].x) / 70,
      xy: (top[block + 1].y - top[block].y + bottom[block + 1].y - bottom[block].y) / 70,
      yx: (bottom[block].x - top[block].x + bottom[block + 1].x - top[block + 1].x) / 70,
      yy: (bottom[block].y - top[block].y + bottom[block + 1].y - top[block + 1].y) / 70,
    };
  }

  function sampleDot(image, geometry, index, dx, dy) {
    const x = geometry.x[index] + dx * geometry.xx + dy * geometry.yx;
    const y = geometry.y[index] + dx * geometry.xy + dy * geometry.yy;
    const radius = 0.2;
    return (
      (sampleRed(image, x, y) * 2 +
        sampleRed(image, x + radius * geometry.xx, y + radius * geometry.xy) +
        sampleRed(image, x - radius * geometry.xx, y - radius * geometry.xy) +
        sampleRed(image, x + radius * geometry.yx, y + radius * geometry.yy) +
        sampleRed(image, x - radius * geometry.yx, y - radius * geometry.yy)) /
      6
    );
  }

  function expectedDots(raw, block, count) {
    const dots = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const byte = raw[block * BYTES_PER_BLOCK + Math.floor(i / 10)];
      const nibble = i % 10 < 5 ? byte >>> 4 : byte & 15;
      dots[i] = (MODULATION_TABLE[nibble] >>> (4 - (i % 5))) & 1;
    }
    return dots;
  }

  function fitOffset(image, geometry, expected) {
    let dx = 0,
      dy = 0;
    const score = (offsetX, offsetY) => {
      let dark = 0,
        darkCount = 0,
        light = 0,
        lightCount = 0;
      for (let i = 0; i < expected.length; i += 3) {
        const value = sampleDot(image, geometry, i, offsetX, offsetY);
        if (expected[i]) {
          dark += value;
          darkCount++;
        } else {
          light += value;
          lightCount++;
        }
      }
      return darkCount && lightCount ? light / lightCount - dark / darkCount : -Infinity;
    };
    let bestScore = score(dx, dy);
    for (const step of [0.25, 0.125, 0.0625]) {
      let nextX = dx,
        nextY = dy;
      for (const shiftY of [-step, 0, step])
        for (const shiftX of [-step, 0, step]) {
          const value = score(dx + shiftX, dy + shiftY);
          if (value > bestScore + 0.000001) {
            bestScore = value;
            nextX = dx + shiftX;
            nextY = dy + shiftY;
          }
        }
      dx = nextX;
      dy = nextY;
    }
    return { dx, dy };
  }

  function calibrate(samples, expected) {
    const dark = new Uint32Array(256),
      light = new Uint32Array(256);
    let darkCount = 0,
      darkSum = 0,
      lightSum = 0;
    for (let i = 0; i < expected.length; i++) {
      const value = samples[i];
      if (expected[i]) {
        dark[value]++;
        darkCount++;
        darkSum += value;
      } else {
        light[value]++;
        lightSum += value;
      }
    }
    const contrast = lightSum / (expected.length - darkCount) - darkSum / darkCount;
    let errors = darkCount,
      best = errors;
    const costs = new Uint16Array(257);
    costs[0] = errors;
    for (let value = 0; value < 256; value++) {
      errors += light[value] - dark[value];
      costs[value + 1] = errors;
      best = Math.min(best, errors);
    }
    let low = 0,
      high = -1;
    for (let start = 0; start < costs.length; start++) {
      if (costs[start] !== best) continue;
      let end = start;
      while (end + 1 < costs.length && costs[end + 1] === best) end++;
      if (end - start > high - low) {
        low = start;
        high = end;
      }
      start = end;
    }
    let lower = low,
      upper = high;
    const tolerance = Math.max(1, Math.floor(expected.length * 0.002));
    while (lower > 0 && costs[lower - 1] <= best + tolerance) lower--;
    while (upper < 256 && costs[upper + 1] <= best + tolerance) upper++;
    const threshold = (low + high - 1) / 2;
    // A wide, empty intensity gap does not make clear black/white cells ambiguous.
    const variation = contrast * 0.1;
    return {
      threshold,
      lower: Math.max(lower - 0.5, threshold - variation),
      upper: Math.min(upper - 0.5, threshold + variation),
      contrast,
      errors: best,
      count: expected.length,
    };
  }

  function readSymbol(samples, offset, threshold) {
    let nibble = 0,
      best = Infinity,
      second = Infinity;
    for (let value = 0; value < 16; value++) {
      const symbol = MODULATION_TABLE[value];
      let cost = 0;
      for (let bit = 0; bit < 5; bit++) {
        const delta = samples[offset + bit] - threshold;
        cost += (symbol >>> (4 - bit)) & 1 ? delta : -delta;
      }
      if (cost < best) {
        second = best;
        best = cost;
        nibble = value;
      } else if (cost < second) second = cost;
    }
    return { nibble, margin: second - best };
  }

  function sampleBlock(image, top, bottom, raw, block, fillerStart) {
    const count = Math.min(BITS_PER_BLOCK, (fillerStart - block * BYTES_PER_BLOCK) * 10);
    const expected = expectedDots(raw, block, count);
    const geometry = blockGeometry(top, bottom, block);
    const offset = fitOffset(image, geometry, expected);
    const features = [],
      observations = [];
    const centers = new Uint8Array(BITS_PER_BLOCK);
    for (let index = 0; index < BITS_PER_BLOCK; index++) {
      const patch = new Float64Array(PROFILE_FEATURE_COUNT);
      let at = 0;
      for (const y of PROFILE_OFFSETS)
        for (const x of PROFILE_OFFSETS) {
          patch[at++] = sampleDot(image, geometry, index, offset.dx + x, offset.dy + y);
        }
      features.push(patch);
      centers[index] = Math.round(patch[PROFILE_CENTER]);
      if (index < count)
        observations.push({
          features: patch,
          label: expected[index],
          validation: Math.floor(index / 10) % 5 === 0,
        });
    }
    return { block, features, observations, expected, centers };
  }

  function usableLevels(levels) {
    return (
      Number.isFinite(levels.contrast) &&
      levels.contrast >= 10 &&
      levels.errors / levels.count <= MAX_CALIBRATION_ERROR_RATE
    );
  }

  function validatedProfile(observations) {
    const training = observations.filter((row) => !row.validation);
    const heldOut = observations.filter((row) => row.validation);
    const candidate = fitDotProfile(training);
    if (!candidate) return null;
    const labels = Uint8Array.from(training, (row) => row.label);
    const profileLevels = calibrate(
      Uint8Array.from(training, (row) => profileIntensity(candidate, row.features)),
      labels,
    );
    const centerLevels = calibrate(
      Uint8Array.from(training, (row) => Math.round(row.features[PROFILE_CENTER])),
      labels,
    );
    if (!usableLevels(profileLevels) || !usableLevels(centerLevels)) return null;
    let profileErrors = 0,
      centerErrors = 0;
    for (const row of heldOut) {
      const expectedDark = Boolean(row.label);
      const profileDark =
        profileIntensity(candidate, row.features) < profileLevels.threshold;
      const centerDark = Math.round(row.features[PROFILE_CENTER]) < centerLevels.threshold;
      if (profileDark !== expectedDark) profileErrors++;
      if (centerDark !== expectedDark) centerErrors++;
    }
    if (profileErrors > centerErrors || profileErrors / heldOut.length > MAX_CALIBRATION_ERROR_RATE)
      return null;
    return fitDotProfile(observations);
  }

  function assessSymbol(samples, offset, levels) {
    const symbol = readSymbol(samples, offset, levels.threshold);
    return {
      nibble: symbol.nibble,
      margin: symbol.margin / levels.contrast,
      uncertain:
        symbol.margin < levels.contrast * MIN_SYMBOL_MARGIN ||
        readSymbol(samples, offset, levels.lower).nibble !== symbol.nibble ||
        readSymbol(samples, offset, levels.upper).nibble !== symbol.nibble,
    };
  }

  function combineSymbols(center, profile) {
    if (!profile) return center;
    if (center.nibble === profile.nibble) {
      return { nibble: profile.nibble, uncertain: center.uncertain && profile.uncertain };
    }
    return {
      nibble: profile.margin > center.margin ? profile.nibble : center.nibble,
      uncertain: true,
    };
  }

  function fitDotProfile(observations) {
    const featureCount = observations[0]?.features.length;
    if (!featureCount) return null;
    const means = [new Float64Array(featureCount), new Float64Array(featureCount)];
    const counts = [0, 0];
    for (const { features, label } of observations) {
      counts[label]++;
      for (let index = 0; index < featureCount; index++) means[label][index] += features[index];
    }
    if (counts.some((count) => count < featureCount * 2)) return null;
    for (let label = 0; label < 2; label++) {
      for (let index = 0; index < featureCount; index++) means[label][index] /= counts[label];
    }
    const covariance = Array.from({ length: featureCount }, () => new Float64Array(featureCount));
    for (const { features, label } of observations) {
      for (let row = 0; row < featureCount; row++) {
        const difference = features[row] - means[label][row];
        for (let column = 0; column <= row; column++) {
          covariance[row][column] += difference * (features[column] - means[label][column]);
        }
      }
    }
    let variance = 0;
    for (let row = 0; row < featureCount; row++) {
      for (let column = 0; column <= row; column++) {
        covariance[row][column] /= observations.length - 2;
        covariance[column][row] = covariance[row][column];
      }
      variance += covariance[row][row];
    }
    // Regularization keeps correlated pixel samples from amplifying noise.
    const ridge = (variance / featureCount) * 0.05 + 0.01;
    for (let index = 0; index < featureCount; index++) covariance[index][index] += ridge;
    const difference = Array.from(means[0], (value, index) => value - means[1][index]);
    const factor = math.factorSymmetric(covariance);
    if (!factor) return null;
    const weights = math.solveFactored(factor, difference);
    let gap = 0,
      midpoint = 0;
    for (let index = 0; index < featureCount; index++) {
      gap += weights[index] * difference[index];
      midpoint += (weights[index] * (means[0][index] + means[1][index])) / 2;
    }
    if (!Number.isFinite(gap) || gap <= 1e-6) return null;
    return { weights, gap, midpoint };
  }

  function profileIntensity(model, features) {
    let value = -model.midpoint;
    for (let index = 0; index < model.weights.length; index++)
      value += features[index] * model.weights[index];
    // Keep the dark/light separation on a bounded intensity scale, not a probability scale.
    return Math.round(Math.max(0, Math.min(255, 127.5 + (value * 120) / model.gap)));
  }

  function createGrid(raw, block, fillerStart) {
    const grid = new Int8Array(GRID_SIZE * GRID_SIZE);
    const addresses = layout.addressSequence(
      raw[BYTES_PER_BLOCK + 1],
      raw.length / BYTES_PER_BLOCK + 1,
    );
    for (const [x, address] of [
      [4, addresses[block]],
      [39, addresses[block + 1]],
    ]) {
      grid[9 * GRID_SIZE + x] = 1;
      for (let bit = 0; bit < 16; bit++) grid[(33 - bit) * GRID_SIZE + x] = (address >>> bit) & 1;
    }
    for (let i = 0; i < 6; i++) {
      for (const x of [10 + i * 2, 23 + i * 2])
        grid[4 * GRID_SIZE + x] = grid[39 * GRID_SIZE + x] = 1;
    }
    for (let bit = 0; bit < BITS_PER_BLOCK; bit++) {
      const [x, y] = layout.dataPosition(bit);
      const at = block * BYTES_PER_BLOCK + Math.floor(bit / 10);
      const nibble = bit % 10 < 5 ? raw[at] >>> 4 : raw[at] & 15;
      grid[y * GRID_SIZE + x] = at < fillerStart ? SYMBOL_BITS[nibble][bit % 5] : -1;
    }
    return grid;
  }

  function contextLabels(grid, bit) {
    const [x, y] = layout.dataPosition(bit);
    const labels = new Float64Array(INPUT_COUNT);
    labels[0] = 1;
    for (let i = 0; i < NEIGHBORS.length; i++) {
      const [dx, dy] = NEIGHBORS[i];
      const label = grid[(y + dy) * GRID_SIZE + x + dx];
      if (label < 0) return null;
      labels[i + 1] = label;
    }
    return labels;
  }

  function fitContext(blocks) {
    const featureCount = blocks[0].features[0].length;
    const rows = [];
    for (const block of blocks) {
      for (let bit = 0; bit < block.expected.length; bit++) {
        const labels = contextLabels(block.grid, bit);
        if (labels) rows.push({ labels, features: block.features[bit] });
      }
    }
    if (rows.length < featureCount * 4) return null;
    const gram = Array.from({ length: INPUT_COUNT }, () => new Float64Array(INPUT_COUNT));
    const products = Array.from({ length: featureCount }, () => new Float64Array(INPUT_COUNT));
    for (const { labels, features } of rows) {
      for (let row = 0; row < INPUT_COUNT; row++) {
        for (let column = 0; column <= row; column++)
          gram[row][column] += labels[row] * labels[column];
        for (let feature = 0; feature < featureCount; feature++)
          products[feature][row] += labels[row] * features[feature];
      }
    }
    for (let row = 0; row < INPUT_COUNT; row++) {
      for (let column = 0; column < row; column++) gram[column][row] = gram[row][column];
      if (row > 0) gram[row][row] += rows.length * 0.001;
    }
    const gramFactor = math.factorSymmetric(gram);
    if (!gramFactor) return null;
    const regressions = products.map((product) => math.solveFactored(gramFactor, product));
    const contrast = -regressions[Math.floor(featureCount / 2)][SELF_INPUT];
    if (!Number.isFinite(contrast) || contrast < 10) return null;
    const covariance = Array.from({ length: featureCount }, () => new Float64Array(featureCount));
    for (const { labels, features } of rows) {
      const residual = Float64Array.from(
        features,
        (value, index) => value - math.dot(regressions[index], labels),
      );
      for (let row = 0; row < featureCount; row++) {
        for (let column = 0; column <= row; column++)
          covariance[row][column] += residual[row] * residual[column];
      }
    }
    let variance = 0;
    for (let row = 0; row < featureCount; row++) {
      for (let column = 0; column <= row; column++) {
        covariance[row][column] /= rows.length - INPUT_COUNT;
        covariance[column][row] = covariance[row][column];
      }
      variance += covariance[row][row];
    }
    const ridge = (variance / featureCount) * 0.05 + 0.01;
    for (let row = 0; row < featureCount; row++) covariance[row][row] += ridge;
    const factor = math.factorSymmetric(covariance);
    if (!factor) return null;
    const coefficients = Array.from({ length: INPUT_COUNT }, (_, input) =>
      math.whiten(
        factor,
        Float64Array.from(regressions, (row) => row[input]),
      ),
    );
    const separation = math.dot(coefficients[SELF_INPUT], coefficients[SELF_INPUT]);
    if (!Number.isFinite(separation) || separation <= 1e-6) return null;
    return {
      factor,
      coefficients,
      separation,
      brightness: math.whiten(factor, new Float64Array(featureCount).fill(contrast * 0.1)),
    };
  }

  function assessContextSymbol(model, block, offset, grid, uncertainGrid = null) {
    const positions = Array.from({ length: 5 }, (_, bit) => layout.dataPosition(offset + bit));
    const cells = positions.map(([x, y]) => y * GRID_SIZE + x);
    const linear = new Float64Array(5),
      brightness = new Float64Array(5);
    const cross = Array.from({ length: 5 }, () => new Float64Array(5));
    const influences = new Map();
    for (let cell = 0; cell < 5; cell++) {
      const [x, y] = positions[cell];
      const residual = math.whiten(model.factor, block.features[offset + cell]);
      for (let feature = 0; feature < residual.length; feature++)
        residual[feature] -= model.coefficients[0][feature];
      const effects = new Array(5).fill(null),
        uncertainNeighbors = [];
      for (let neighbor = 0; neighbor < NEIGHBORS.length; neighbor++) {
        const [dx, dy] = NEIGHBORS[neighbor];
        const position = (y + dy) * GRID_SIZE + x + dx;
        const target = cells.indexOf(position),
          coefficient = model.coefficients[neighbor + 1];
        if (target !== -1) {
          effects[target] = coefficient;
          continue;
        }
        const label = grid[position];
        if (label < 0) return null;
        for (let feature = 0; feature < residual.length; feature++)
          residual[feature] -= label * coefficient[feature];
        if (uncertainGrid?.[position]) {
          if (!influences.has(position))
            influences.set(position, { label, linear: new Float64Array(5) });
          uncertainNeighbors.push({ influence: influences.get(position), coefficient });
        }
      }
      for (let bit = 0; bit < 5; bit++) {
        const effect = effects[bit];
        if (!effect) continue;
        linear[bit] += math.dot(effect, effect) - 2 * math.dot(residual, effect);
        brightness[bit] -= 2 * math.dot(model.brightness, effect);
        for (let other = 0; other < bit; other++) {
          if (effects[other]) cross[bit][other] += 2 * math.dot(effect, effects[other]);
        }
        for (const { influence, coefficient } of uncertainNeighbors)
          influence.linear[bit] += 2 * math.dot(effect, coefficient);
      }
    }
    const costs = Float64Array.from(SYMBOL_BITS, (bits) => {
      let cost = math.dot(linear, bits);
      for (let bit = 0; bit < 5; bit++) {
        if (bits[bit])
          for (let other = 0; other < bit; other++) cost += cross[bit][other] * bits[other];
      }
      return cost;
    });
    let nibble = 0;
    for (let value = 1; value < costs.length; value++)
      if (costs[value] < costs[nibble]) nibble = value;
    let margin = Infinity,
      nominalMargin = Infinity;
    for (let value = 0; value < costs.length; value++) {
      if (value === nibble) continue;
      const difference = Float64Array.from(
        SYMBOL_BITS[value],
        (bit, index) => bit - SYMBOL_BITS[nibble][index],
      );
      const nominalDistance = costs[value] - costs[nibble];
      nominalMargin = Math.min(nominalMargin, nominalDistance);
      let distance = nominalDistance - Math.abs(math.dot(brightness, difference));
      // Bound every uncertain neighbor independently so ambiguous dots cannot confirm each other.
      for (const influence of influences.values()) {
        const change = math.dot(influence.linear, difference);
        distance += change >= 0 ? -influence.label * change : (1 - influence.label) * change;
      }
      margin = Math.min(margin, distance);
    }
    return {
      nibble,
      uncertain: nominalMargin < model.separation * MIN_SYMBOL_MARGIN || margin <= 0,
    };
  }

  function validatedContext(blocks, raw) {
    const heldOut = blocks[blocks.length - 1];
    const candidate = fitContext(blocks.slice(0, -1));
    if (!candidate) return null;
    let checked = 0;
    for (let offset = 0; offset < heldOut.expected.length; offset += 5) {
      const symbol = assessContextSymbol(candidate, heldOut, offset, heldOut.grid);
      if (!symbol) continue;
      const byte = raw[heldOut.block * BYTES_PER_BLOCK + Math.floor(offset / 10)];
      const expected = offset % 10 === 0 ? byte >>> 4 : byte & 15;
      if (symbol.nibble !== expected) return null;
      checked++;
    }
    return checked >= 64 ? fitContext(blocks) : null;
  }

  function refineFiller(raw, sampledBlocks, fillerStart, uncertainSymbols) {
    const unchanged = { raw, uncertainSymbols, calibrated: false };
    if (uncertainSymbols.length === 0) return unchanged;
    const blocks = sampledBlocks.map((block) => ({
      ...block,
      grid: createGrid(raw, block.block, fillerStart),
    }));
    const model = validatedContext(blocks, raw);
    if (!model) return unchanged;
    for (const block of blocks) {
      block.grid = createGrid(raw, block.block, Infinity);
      block.uncertainGrid = new Uint8Array(GRID_SIZE * GRID_SIZE);
      for (const symbol of uncertainSymbols) {
        const offset = (symbol - block.block * SYMBOLS_PER_BLOCK) * 5;
        if (offset < 0 || offset >= BITS_PER_BLOCK) continue;
        for (let bit = 0; bit < 5; bit++) {
          const [x, y] = layout.dataPosition(offset + bit);
          block.uncertainGrid[y * GRID_SIZE + x] = 1;
        }
      }
    }
    const output = new Uint8Array(raw),
      remaining = [];
    for (const index of uncertainSymbols) {
      const at = Math.floor(index / 2),
        blockIndex = Math.floor(at / BYTES_PER_BLOCK);
      const block = blocks[blockIndex - blocks[0].block];
      const offset = (index - blockIndex * SYMBOLS_PER_BLOCK) * 5;
      const symbol = assessContextSymbol(model, block, offset, block.grid, block.uncertainGrid);
      const shift = index % 2 === 0 ? 4 : 0;
      if (!symbol || symbol.uncertain) {
        remaining.push(index);
        continue;
      }
      if (symbol.nibble !== ((raw[at] >>> shift) & 15)) remaining.push(index);
      output[at] = (output[at] & ~(15 << shift)) | (symbol.nibble << shift);
    }
    return { raw: output, uncertainSymbols: remaining, calibrated: true };
  }

  function assignNibble(raw, symbol, nibble) {
    const at = symbol >>> 1;
    const shift = symbol % 2 ? 0 : 4;
    raw[at] = (raw[at] & ~(15 << shift)) | (nibble << shift);
  }

  function symbolBlock(blocks, symbol) {
    const block = Math.floor(symbol / (SYMBOLS_PER_BLOCK));
    return blocks[block - blocks[0].block];
  }

  function assess(model, block, symbol, grid, uncertainGrid = null) {
    return assessContextSymbol(model, block,
      (symbol % (SYMBOLS_PER_BLOCK)) * 5, grid, uncertainGrid);
  }

  function sameBytes(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function buildObjective(model, block, raw, fillerStart) {
    const firstBit = (fillerStart - block.block * BYTES_PER_BLOCK) * 10;
    const count = BITS_PER_BLOCK - firstBit;
    const variableGrid = new Int32Array(GRID_SIZE * GRID_SIZE).fill(-1);
    const known = createGrid(raw, block.block, Infinity);
    for (let i = 0; i < count; i++) {
      const [x, y] = layout.dataPosition(firstBit + i);
      variableGrid[y * GRID_SIZE + x] = i;
    }
    const linear = new Float64Array(count);
    const pair = Array.from({ length: count }, () => new Float64Array(count));
    let constant = 0;
    for (let patch = 0; patch < BITS_PER_BLOCK; patch++) {
      const [x, y] = layout.dataPosition(patch);
      const base = math.whiten(model.factor, block.features[patch]);
      for (let feature = 0; feature < base.length; feature++) base[feature] -= model.coefficients[0][feature];
      const effects = [];
      for (let neighbor = 0; neighbor < 9; neighbor++) {
        const dx = neighbor % 3 - 1;
        const dy = Math.floor(neighbor / 3) - 1;
        const cell = (y + dy) * GRID_SIZE + x + dx;
        const variable = variableGrid[cell];
        const coefficient = model.coefficients[neighbor + 1];
        if (variable >= 0) {
          effects.push({ variable, coefficient });
        } else {
          for (let feature = 0; feature < base.length; feature++) {
            base[feature] -= known[cell] * coefficient[feature];
          }
        }
      }
      constant += math.dot(base, base);
      for (let i = 0; i < effects.length; i++) {
        const a = effects[i];
        linear[a.variable] += math.dot(a.coefficient, a.coefficient) - 2 * math.dot(base, a.coefficient);
        for (let j = 0; j < i; j++) {
          const b = effects[j];
          const weight = 2 * math.dot(a.coefficient, b.coefficient);
          pair[a.variable][b.variable] += weight;
          pair[b.variable][a.variable] += weight;
        }
      }
    }
    const neighbors = pair.map((row) =>
      Array.from(row, (weight, index) => ({ weight, index })).filter((item) => item.weight !== 0),
    );
    const coupled = new Set();
    for (let i = 0; i < count; i++) {
      for (const { index } of neighbors[i]) {
        const a = Math.floor(i / 5);
        const b = Math.floor(index / 5);
        if (a < b) coupled.add(a + "," + b);
      }
    }
    return {
      linear,
      pair,
      neighbors,
      constant,
      coupledSymbols: [...coupled].map((value) => value.split(",").map(Number)),
    };
  }

  function initialLabels(raw, fillerStart) {
    const labels = new Uint8Array((raw.length - fillerStart) * 10);
    for (let symbol = 0; symbol < labels.length / 5; symbol++) {
      const at = fillerStart + (symbol >>> 1);
      const nibble = (raw[at] >>> (symbol % 2 ? 0 : 4)) & 15;
      labels.set(SYMBOL_BITS[nibble], symbol * 5);
    }
    return labels;
  }

  function imageEnergy(objective, labels) {
    let energy = objective.constant;
    for (let i = 0; i < labels.length; i++) {
      if (!labels[i]) continue;
      energy += objective.linear[i];
      for (const { index, weight } of objective.neighbors[i]) {
        if (index < i && labels[index]) energy += weight;
      }
    }
    return energy;
  }

  function symbolCosts(objective, labels, offset, excludedOffset = -10) {
    const linear = new Float64Array(5);
    for (let bit = 0; bit < 5; bit++) {
      const variable = offset + bit;
      linear[bit] = objective.linear[variable];
      for (const { index, weight } of objective.neighbors[variable]) {
        if (
          (index < offset || index >= offset + 5) &&
          (index < excludedOffset || index >= excludedOffset + 5)
        ) {
          linear[bit] += weight * labels[index];
        }
      }
    }
    return SYMBOL_BITS.map(bits => {
      let cost = 0;
      for (let bit = 0; bit < 5; bit++) {
        cost += linear[bit] * bits[bit];
        for (let other = 0; other < bit; other++) {
          cost += objective.pair[offset + bit][offset + other] * bits[bit] * bits[other];
        }
      }
      return cost;
    });
  }

  function improveCoupledSymbols(objective, labels, raw, fillerStart) {
    let changes = 0;
    for (const [symbolA, symbolB] of objective.coupledSymbols) {
      const offsetA = symbolA * 5;
      const offsetB = symbolB * 5;
      const costsA = symbolCosts(objective, labels, offsetA, offsetB);
      const costsB = symbolCosts(objective, labels, offsetB, offsetA);
      const cross = Array.from({ length: 16 }, (_, a) => Float64Array.from({ length: 16 }, (_, b) => {
        let cost = 0;
        for (let i = 0; i < 5; i++) {
          for (let j = 0; j < 5; j++) cost += objective.pair[offsetA + i][offsetB + j] * SYMBOL_BITS[a][i] * SYMBOL_BITS[b][j];
        }
        return cost;
      }));
      const atA = fillerStart + (symbolA >>> 1);
      const atB = fillerStart + (symbolB >>> 1);
      const shiftA = symbolA % 2 ? 0 : 4;
      const shiftB = symbolB % 2 ? 0 : 4;
      const oldA = (raw[atA] >>> shiftA) & 15;
      const oldB = (raw[atB] >>> shiftB) & 15;
      let bestA = oldA;
      let bestB = oldB;
      let bestCost = costsA[oldA] + costsB[oldB] + cross[oldA][oldB];
      for (let a = 0; a < 16; a++) {
        for (let b = 0; b < 16; b++) {
          const cost = costsA[a] + costsB[b] + cross[a][b];
          if (cost < bestCost - 1e-8) {
            bestCost = cost;
            bestA = a;
            bestB = b;
          }
        }
      }
      if (bestA !== oldA || bestB !== oldB) {
        changes += Number(bestA !== oldA) + Number(bestB !== oldB);
        assignNibble(raw, fillerStart * 2 + symbolA, bestA);
        assignNibble(raw, fillerStart * 2 + symbolB, bestB);
        labels.set(SYMBOL_BITS[bestA], offsetA);
        labels.set(SYMBOL_BITS[bestB], offsetB);
      }
    }
    return changes;
  }

  function optimizeImage(objective, initial, fillerStart) {
    const raw = new Uint8Array(initial);
    const labels = initialLabels(raw, fillerStart);
    let totalPairChanges = 0;
    let converged = false;
    let lastEnergy = imageEnergy(objective, labels);
    for (let pass = 0; pass < 64; pass++) {
      let changes = 0;
      for (let symbol = 0; symbol < labels.length / 5; symbol++) {
        const costs = symbolCosts(objective, labels, symbol * 5);
        const at = fillerStart + (symbol >>> 1);
        const current = (raw[at] >>> (symbol % 2 ? 0 : 4)) & 15;
        let best = current;
        for (let candidate = 0; candidate < 16; candidate++) {
          if (costs[candidate] < costs[best] - 1e-8) best = candidate;
        }
        if (best !== current) {
          changes++;
          assignNibble(raw, fillerStart * 2 + symbol, best);
          labels.set(SYMBOL_BITS[best], symbol * 5);
        }
      }
      const pairChanges =
        changes === 0 ? improveCoupledSymbols(objective, labels, raw, fillerStart) : 0;
      changes += pairChanges;
      const energy = imageEnergy(objective, labels);
      if (energy > lastEnergy + 1e-6) throw new Error("Joint image objective increased");
      totalPairChanges += pairChanges;
      lastEnergy = energy;
      if (!changes) {
        converged = true;
        break;
      }
    }
    return { raw, energy: lastEnergy, converged, pairChanges: totalPairChanges };
  }

  function robustRead(model, blocks, initial, fillerStart) {
    const raw = new Uint8Array(initial);
    const uncertain = new Set(
      Array.from({ length: (raw.length - fillerStart) * 2 }, (_, index) => fillerStart * 2 + index),
    );
    for (let pass = 0; pass < 32; pass++) {
      const gridSnapshots = new Map();
      const maskSnapshots = new Map();
      for (const block of blocks) {
        gridSnapshots.set(block.block, createGrid(raw, block.block, Infinity));
        maskSnapshots.set(block.block, new Uint8Array(GRID_SIZE * GRID_SIZE));
      }
      for (const symbol of uncertain) {
        const mask = maskSnapshots.get(Math.floor(symbol / SYMBOLS_PER_BLOCK));
        for (let bit = 0; bit < 5; bit++) {
          const [x, y] = layout.dataPosition((symbol % SYMBOLS_PER_BLOCK) * 5 + bit);
          mask[y * GRID_SIZE + x] = 1;
        }
      }
      const updates = [];
      for (const symbol of uncertain) {
        const block = symbolBlock(blocks, symbol);
        const decision = assess(
          model,
          block,
          symbol,
          gridSnapshots.get(block.block),
          maskSnapshots.get(block.block),
        );
        if (decision && !decision.uncertain) updates.push({ symbol, nibble: decision.nibble });
      }
      for (const { symbol, nibble } of updates) {
        assignNibble(raw, symbol, nibble);
        uncertain.delete(symbol);
      }
      if (!updates.length || !uncertain.size) break;
    }
    return { raw, uncertainSymbols: [...uncertain] };
  }

  function refineLowResolutionFiller(raw, sampledBlocks, fillerStart) {
    const uncertainSymbols = Array.from(
      { length: (raw.length - fillerStart) * 2 },
      (_, index) => fillerStart * 2 + index,
    );
    const unchanged = { raw, uncertainSymbols, calibrated: false, details: null };
    if (sampledBlocks.length < 3) return unchanged;
    const allBlocks = sampledBlocks.map((block) => ({
      ...block,
      grid: createGrid(raw, block.block, fillerStart),
    }));
    const options = [];
    for (const count of [...new Set([3, 6, 12, allBlocks.length])]) {
      if (count > allBlocks.length) continue;
      const blocks = allBlocks.slice(-count);
      const candidate = fitContext(blocks.slice(0, -1));
      if (!candidate) continue;
      const heldOut = blocks[blocks.length - 1];
      let checked = 0;
      let errors = 0;
      let uncertain = 0;
      for (let offset = 0; offset < heldOut.expected.length; offset += 5) {
        const decision = assessContextSymbol(candidate, heldOut, offset, heldOut.grid);
        if (!decision) continue;
        const at = heldOut.block * BYTES_PER_BLOCK + Math.floor(offset / 10);
        const expected = (raw[at] >>> (offset % 10 ? 0 : 4)) & 15;
        checked++;
        errors += decision.nibble !== expected;
        uncertain += decision.uncertain;
      }
      if (checked >= 64) options.push({ blocks, count, checked, errors, uncertain });
    }
    options.sort((a, b) =>
      a.errors / a.checked - b.errors / b.checked ||
      a.uncertain / a.checked - b.uncertain / b.checked ||
      a.count - b.count,
    );
    const choice = options[0];
    if (!choice || choice.errors !== 0) return unchanged;
    const model = fitContext(choice.blocks);
    if (!model) return unchanged;
    const objective = buildObjective(model, choice.blocks[choice.blocks.length - 1], raw, fillerStart);
    const robust = robustRead(model, choice.blocks, raw, fillerStart);
    const runs = [optimizeImage(objective, raw, fillerStart)];
    const initializers = [
      () => 0,
      () => 255,
      (index) => index % 2 ? 0xaa : 0x55,
    ];
    for (const initialState of [0x517cc1b7, 0x2d93a4e5]) {
      let state = initialState;
      initializers.push(() => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state & 255;
      });
    }
    for (const initialize of initializers) {
      const seed = new Uint8Array(raw);
      for (let at = fillerStart; at < seed.length; at++) seed[at] = initialize(at - fillerStart);
      runs.push(optimizeImage(objective, seed, fillerStart));
    }
    const converged = runs.filter(run => run.converged).sort((a, b) => a.energy - b.energy);
    if (!converged.length) return unchanged;
    const selected = converged[0];
    const unique = [];
    for (const run of runs) {
      if (!unique.some((previous) => sameBytes(run.raw, previous.raw))) unique.push(run);
    }
    const nextDifferent = converged.find(run => !sameBytes(run.raw, selected.raw));
    const unresolved = new Set(robust.uncertainSymbols);
    for (const symbol of uncertainSymbols) {
      const at = symbol >>> 1;
      const shift = symbol % 2 ? 0 : 4;
      if (((selected.raw[at] >>> shift) & 15) !== ((robust.raw[at] >>> shift) & 15)) {
        unresolved.add(symbol);
      }
    }
    return {
      raw: selected.raw,
      calibrated: true,
      uncertainSymbols: [...unresolved].sort((a, b) => a - b),
      details: Object.freeze({
        trainingBlocks: choice.count,
        profileHoldout: Object.freeze({
          checked: choice.checked,
          errors: choice.errors,
          uncertain: choice.uncertain,
        }),
        geometryUsesProtectedLabels: true,
        geometryHoldout: false,
        startCount: runs.length,
        distinctOutputs: unique.length,
        convergedEach: runs.every(run => run.converged),
        energy: selected.energy,
        energyGapToNextDifferentOutput: nextDifferent ? nextDifferent.energy - selected.energy : null,
        globalMinimumProven: false,
        pairChanges: selected.pairChanges,
        robustAllResolved: unresolved.size === 0,
      }),
    };
  }

  function refineRaw(image, top, bottom, raw) {
    const blockCount = raw.length / BYTES_PER_BLOCK;
    const pitch =
      Math.hypot(top[blockCount].x - top[0].x, top[blockCount].y - top[0].y) / (blockCount * 35);
    const columns = blockCount === layout.LONG_BLOCK_COUNT ? 44 : 28;
    const fillerStart = columns * 64 + blockCount * 2;
    const firstBlock = Math.floor(fillerStart / BYTES_PER_BLOCK);
    const trainingStart = Math.max(0, firstBlock - 2);
    top = top.slice();
    bottom = bottom.slice();
    for (let marker = trainingStart; marker <= blockCount; marker++) {
      top[marker] = refineMarker(image, top[marker], pitch);
      bottom[marker] = refineMarker(image, bottom[marker], pitch);
    }
    const sampledBlocks = [],
      observations = [];
    for (let block = trainingStart; block < blockCount; block++) {
      const sampled = sampleBlock(image, top, bottom, raw, block, fillerStart);
      sampledBlocks.push(sampled);
      observations.push(...sampled.observations);
    }
    const profile = validatedProfile(observations);
    const output = new Uint8Array(raw),
      uncertainSymbols = [];
    let calibrated = true,
      profileCalibrated = Boolean(profile);
    // Only ECC-protected bits supply labels; filler never trains the reader.
    for (let block = firstBlock; block < blockCount; block++) {
      const sampled = sampledBlocks[block - trainingStart];
      const { expected, centers: samples } = sampled;
      const levels = calibrate(samples, expected);
      const profileSamples = profile
        ? Uint8Array.from(sampled.features, (features) =>
            profileIntensity(profile, features),
          )
        : null;
      const profileLevels = profileSamples ? calibrate(profileSamples, expected) : null;
      const usableProfile = profileLevels && usableLevels(profileLevels);
      profileCalibrated &&= Boolean(usableProfile);
      const usable = usableLevels(levels);
      calibrated &&= usable;
      for (
        let byte = Math.max(0, fillerStart - block * BYTES_PER_BLOCK);
        byte < BYTES_PER_BLOCK;
        byte++
      ) {
        const at = block * BYTES_PER_BLOCK + byte;
        if (!usable) {
          uncertainSymbols.push(at * 2, at * 2 + 1);
          continue;
        }
        let value = 0;
        for (let half = 0; half < 2; half++) {
          const sampleOffset = byte * 10 + half * 5;
          const symbol = combineSymbols(
            assessSymbol(samples, sampleOffset, levels),
            usableProfile ? assessSymbol(profileSamples, sampleOffset, profileLevels) : null,
          );
          value = (value << 4) | symbol.nibble;
          if (symbol.uncertain) uncertainSymbols.push(at * 2 + half);
        }
        output[at] = value;
      }
    }
    const refinement =
      calibrated && profileCalibrated
        ? refineFiller(output, sampledBlocks, fillerStart, uncertainSymbols)
        : { raw: output, uncertainSymbols, calibrated: false };
    const uncertain = [
      ...new Set(refinement.uncertainSymbols.map((symbol) => Math.floor(symbol / 2))),
    ];
    return {
      raw: refinement.raw,
      quality: Object.freeze({
        fillerStart,
        fillerBytes: raw.length - fillerStart,
        calibrated,
        profileCalibrated,
        contextCalibrated: refinement.calibrated,
        uncertainFillerBytes: Object.freeze(uncertain),
      }),
    };
  }

  function refineLowResolutionRaw(image, top, bottom, raw) {
    const blockCount = raw.length / BYTES_PER_BLOCK;
    if (![layout.LONG_BLOCK_COUNT, layout.SHORT_BLOCK_COUNT].includes(blockCount) ||
        top.length !== blockCount + 1 || bottom.length !== blockCount + 1) {
      throw new TypeError("Low-resolution filler refinement needs a complete dot-code strip");
    }
    const columns = blockCount === layout.LONG_BLOCK_COUNT ? 44 : 28;
    const fillerStart = columns * 64 + blockCount * 2;
    const blocks = [];
    for (let block = 0; block < blockCount; block++) {
      blocks.push(sampleBlock(image, top, bottom, raw, block, fillerStart));
    }
    const result = refineLowResolutionFiller(raw, blocks, fillerStart);
    return {
      raw: result.raw,
      quality: Object.freeze({
        fillerStart,
        fillerBytes: raw.length - fillerStart,
        calibrated: false,
        profileCalibrated: false,
        contextCalibrated: result.calibrated,
        uncertainFillerBytes: Object.freeze([
          ...new Set(result.uncertainSymbols.map(symbol => Math.floor(symbol / 2))),
        ]),
        lowResolutionRefinement: result.details,
      }),
    };
  }

  return Object.freeze({ refineRaw, refineLowResolutionRaw });
});
