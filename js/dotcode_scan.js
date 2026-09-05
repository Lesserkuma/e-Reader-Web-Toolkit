(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./binary.js"),
      require("./dotcode_layout.js"),
      require("./processing_limits.js"),
      require("./reed_solomon.js"),
      require("./raw_codec.js"),
      require("./dotcode_sampling.js"),
      require("./dotcode_recovery.js"),
    );
  } else {
    root.EReaderDotcodeScan = factory(
      root.EReaderBinary,
      root.EReaderDotcodeLayout,
      root.EReaderProcessingLimits,
      root.EReaderReedSolomon,
      root.EReaderRawCodec,
      root.EReaderDotcodeSampling,
      root.EReaderDotcodeRecovery,
    );
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function (binary, layout, limits, reedSolomon, rawModule, sampling, recovery) {
    "use strict";

    const {
      LONG_BLOCK_COUNT,
      SHORT_BLOCK_COUNT,
      BYTES_PER_BLOCK,
      BITS_PER_BLOCK,
      MODULATION_TABLE,
    } = layout;
    const { MAX_IMAGE_PIXELS, MAX_IMAGE_DIMENSION } = limits;

    const RS_CODEWORD_SIZE = 64;

    const RS_DATA_SIZE = 48;

    const RS_PARITY_SIZE = RS_CODEWORD_SIZE - RS_DATA_SIZE;

    const LOCATOR_MAX_DIMENSION = 1_600;

    const MAX_NORMALIZED_PIXELS = 20_000_000;

    const MAX_COARSE_MARKER_CANDIDATES = 768;

    const MAX_PRECISE_MARKER_CANDIDATES_PER_ROW = 80;

    const MAX_DIRECTIONAL_MARKER_ROWS_PER_LENGTH = 128;

    const MAX_MARKER_GRIDS_PER_THRESHOLD = 96;

    const MAX_LOCATED_MARKER_GRIDS = 64;

    const MAX_RECOVERY_ATTEMPTS = 8;

    const JPEG_START_OF_FRAME_MARKERS = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ]);

    class DotcodeScanError extends Error {
      constructor(message) {
        super(message);
        this.name = "DotcodeScanError";
      }
    }

    function asByteArray(value, label) {
      if (value instanceof Uint8Array || value instanceof Uint8ClampedArray) {
        return value;
      }
      if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
      }
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
      throw new TypeError(`${label} must be a byte array`);
    }

    function checkedEncodedImageDimensions(width, height, format, label) {
      const pixelCount = width * height;
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        width > MAX_IMAGE_DIMENSION ||
        height > MAX_IMAGE_DIMENSION ||
        !Number.isSafeInteger(pixelCount) ||
        pixelCount > MAX_IMAGE_PIXELS
      ) {
        throw new DotcodeScanError(
          `${label} dimensions (${width} x ${height}) are too large to decode safely`,
        );
      }
      return Object.freeze({ format, width, height });
    }

    function inspectEncodedImageDimensions(input, label = "Dotcode image") {
      const bytes = asByteArray(input, label);
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (
        bytes.length >= 24 &&
        pngSignature.every((value, index) => bytes[index] === value) &&
        bytes[12] === 0x49 &&
        bytes[13] === 0x48 &&
        bytes[14] === 0x44 &&
        bytes[15] === 0x52
      ) {
        const width = ((bytes[16] * 0x100 + bytes[17]) * 0x100 + bytes[18]) * 0x100 + bytes[19];
        const height = ((bytes[20] * 0x100 + bytes[21]) * 0x100 + bytes[22]) * 0x100 + bytes[23];
        return checkedEncodedImageDimensions(width, height, "PNG", label);
      }

      if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset < bytes.length) {
          if (bytes[offset] !== 0xff) {
            throw new DotcodeScanError(`${label} has an invalid JPEG marker stream`);
          }
          while (offset < bytes.length && bytes[offset] === 0xff) {
            offset += 1;
          }
          if (offset >= bytes.length) {
            break;
          }
          const marker = bytes[offset];
          offset += 1;
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            continue;
          }
          if (marker === 0xd9 || marker === 0xda) {
            break;
          }
          if (offset + 2 > bytes.length) {
            break;
          }
          const segmentLength = bytes[offset] * 0x100 + bytes[offset + 1];
          if (segmentLength < 2 || offset + segmentLength > bytes.length) {
            throw new DotcodeScanError(`${label} has an invalid JPEG segment length`);
          }
          if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
            if (segmentLength < 7) {
              throw new DotcodeScanError(`${label} has a truncated JPEG frame header`);
            }
            const height = bytes[offset + 3] * 0x100 + bytes[offset + 4];
            const width = bytes[offset + 5] * 0x100 + bytes[offset + 6];
            return checkedEncodedImageDimensions(width, height, "JPEG", label);
          }
          offset += segmentLength;
        }
        throw new DotcodeScanError(`${label} has no JPEG frame dimensions`);
      }
      throw new DotcodeScanError(`${label} is not a supported PNG or JPEG image`);
    }

    function asRgbaImage(image) {
      if (!image || typeof image !== "object") {
        throw new TypeError("Dotcode image must be an object with width, height, and RGBA data");
      }

      const width = image.width;
      const height = image.height;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
        throw new TypeError("Dotcode image width and height must be positive integers");
      }
      if (Math.max(width, height) < 200 || Math.min(width, height) < 40) {
        throw new DotcodeScanError("The image is too small to contain an e-Reader dotcode strip");
      }

      const pixelCount = width * height;
      if (
        width > MAX_IMAGE_DIMENSION ||
        height > MAX_IMAGE_DIMENSION ||
        !Number.isSafeInteger(pixelCount) ||
        pixelCount > MAX_IMAGE_PIXELS
      ) {
        throw new DotcodeScanError("The image dimensions are too large to decode safely");
      }

      const data = asByteArray(image.data, "Dotcode image data");
      const requiredLength = pixelCount * 4;
      if (data.byteLength !== requiredLength) {
        throw new TypeError(
          `Dotcode image needs exactly ${requiredLength} RGBA bytes, but ${data.byteLength} were supplied`,
        );
      }
      return { width, height, data };
    }

    function redAt(image, pixelIndex) {
      return image.redOnly ? image.data[pixelIndex] : image.data[pixelIndex * 4];
    }

    function redHistogram(image) {
      const histogram = new Uint32Array(256);
      const pixelCount = image.width * image.height;
      for (let index = 0; index < pixelCount; index += 1) {
        histogram[redAt(image, index)] += 1;
      }
      return histogram;
    }

    function histogramQuantile(histogram, pixelCount, fraction) {
      const target = Math.max(1, Math.floor(pixelCount * fraction));
      let cumulative = 0;
      for (let value = 0; value < histogram.length; value += 1) {
        cumulative += histogram[value];
        if (cumulative >= target) {
          return value;
        }
      }
      return 255;
    }

    function locatorImage(image) {
      const maximumDimension = Math.max(image.width, image.height);
      if (maximumDimension <= LOCATOR_MAX_DIMENSION) {
        return { image, scaleX: 1, scaleY: 1 };
      }
      const previewScale = LOCATOR_MAX_DIMENSION / maximumDimension;
      const width = Math.max(1, Math.round(image.width * previewScale));
      const height = Math.max(1, Math.round(image.height * previewScale));
      const scaleX = image.width / width;
      const scaleY = image.height / height;
      const data = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1) {
        const sourceTop = Math.floor(y * scaleY);
        const sourceBottom = Math.min(image.height, Math.ceil((y + 1) * scaleY));
        for (let x = 0; x < width; x += 1) {
          const sourceLeft = Math.floor(x * scaleX);
          const sourceRight = Math.min(image.width, Math.ceil((x + 1) * scaleX));
          let sum = 0;
          let count = 0;
          for (let sourceY = sourceTop; sourceY < sourceBottom; sourceY += 1) {
            for (let sourceX = sourceLeft; sourceX < sourceRight; sourceX += 1) {
              sum += redAt(image, sourceY * image.width + sourceX);
              count += 1;
            }
          }
          data[y * width + x] = Math.round(sum / count);
        }
      }
      return {
        image: { width, height, data, redOnly: true },
        scaleX,
        scaleY,
      };
    }

    function* darkComponents(image, threshold) {
      const { width, height } = image;
      const pixelCount = width * height;
      const visited = new Uint8Array(pixelCount);
      let stack = new Int32Array(Math.min(pixelCount, 1024));
      let stackSize = 0;
      const pushPixel = (pixel) => {
        if (stackSize === stack.length) {
          const grown = new Int32Array(Math.min(pixelCount, stack.length * 2));
          grown.set(stack);
          stack = grown;
        }
        stack[stackSize] = pixel;
        stackSize += 1;
      };

      for (let seed = 0; seed < pixelCount; seed += 1) {
        if (visited[seed] || redAt(image, seed) > threshold) {
          continue;
        }

        stackSize = 0;
        pushPixel(seed);
        visited[seed] = 1;

        let area = 0;
        let sumX = 0;
        let sumY = 0;
        let minX = width;
        let minY = height;
        let maxX = 0;
        let maxY = 0;

        while (stackSize > 0) {
          stackSize -= 1;
          const pixel = stack[stackSize];
          const y = Math.floor(pixel / width);
          const x = pixel - y * width;

          area += 1;
          sumX += x;
          sumY += y;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);

          const yStart = Math.max(0, y - 1);
          const yEnd = Math.min(height - 1, y + 1);
          const xStart = Math.max(0, x - 1);
          const xEnd = Math.min(width - 1, x + 1);
          for (let neighborY = yStart; neighborY <= yEnd; neighborY += 1) {
            let neighbor = neighborY * width + xStart;
            for (let neighborX = xStart; neighborX <= xEnd; neighborX += 1, neighbor += 1) {
              if (!visited[neighbor] && redAt(image, neighbor) <= threshold) {
                visited[neighbor] = 1;
                pushPixel(neighbor);
              }
            }
          }
        }

        if (area < 4) {
          continue;
        }
        const componentWidth = maxX - minX + 1;
        const componentHeight = maxY - minY + 1;
        const aspect = componentWidth / componentHeight;
        const fill = area / (componentWidth * componentHeight);
        if (
          componentWidth >= 2 &&
          componentHeight >= 2 &&
          aspect >= 0.45 &&
          aspect <= 2.2 &&
          fill >= 0.2 &&
          componentWidth <= height * 0.3 &&
          componentHeight <= height * 0.3
        ) {
          yield {
            x: sumX / area,
            y: sumY / area,
            area,
            width: componentWidth,
            height: componentHeight,
          };
        }
      }
    }

    function compareMarkerComponentPriority(left, right) {
      return (
        left.area - right.area ||
        Math.abs(right.width - right.height) - Math.abs(left.width - left.height) ||
        right.y - left.y ||
        right.x - left.x
      );
    }

    function retainMarkerComponent(heap, candidate, limit) {
      if (limit <= 0) {
        return;
      }
      if (heap.length < limit) {
        heap.push(candidate);
        let index = heap.length - 1;
        while (index > 0) {
          const parent = (index - 1) >>> 1;
          if (compareMarkerComponentPriority(heap[index], heap[parent]) >= 0) {
            break;
          }
          [heap[index], heap[parent]] = [heap[parent], heap[index]];
          index = parent;
        }
        return;
      }
      if (compareMarkerComponentPriority(candidate, heap[0]) <= 0) {
        return;
      }
      heap[0] = candidate;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length) {
          break;
        }
        const right = left + 1;
        let worse = left;
        if (right < heap.length && compareMarkerComponentPriority(heap[right], heap[left]) < 0) {
          worse = right;
        }
        if (compareMarkerComponentPriority(heap[worse], heap[index]) >= 0) {
          break;
        }
        [heap[index], heap[worse]] = [heap[worse], heap[index]];
        index = worse;
      }
    }

    function retainedMarkerComponents(heap) {
      return heap.slice().sort((left, right) => compareMarkerComponentPriority(right, left));
    }

    function lowerBoundByX(points, x) {
      let low = 0;
      let high = points.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (points[middle].x < x) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      return low;
    }

    function assessMarkerRow(points, imageWidth, imageHeight) {
      if (points.length < 2) {
        return null;
      }
      const ordered = points.slice().sort((left, right) => left.x - right.x);
      const span = ordered[ordered.length - 1].x - ordered[0].x;
      if (span < imageWidth * 0.5) {
        return null;
      }

      const expectedSpacing = span / (ordered.length - 1);
      let score = 0;
      let largestSpacingError = 0;
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const yTolerance = Math.max(4, imageHeight * 0.045);

      for (let index = 0; index < ordered.length; index += 1) {
        const expectedX = first.x + expectedSpacing * index;
        const expectedY = first.y + ((last.y - first.y) * index) / (ordered.length - 1);
        const spacingError = Math.abs(ordered[index].x - expectedX) / expectedSpacing;
        const yError = Math.abs(ordered[index].y - expectedY) / yTolerance;
        largestSpacingError = Math.max(largestSpacingError, spacingError);
        score += spacingError * spacingError + yError * yError * 0.05;
      }
      if (largestSpacingError > 0.18) {
        return null;
      }
      return { points: ordered, score: score / ordered.length };
    }

    function findMarkerRow(candidates, count, imageWidth, imageHeight) {
      if (candidates.length < count) {
        return null;
      }

      // Sync markers are substantially larger than ordinary data dots. Keeping
      // a modest surplus handles dust and JPEG islands without making the
      // regular-grid search expensive.
      const pool = candidates
        .slice()
        .sort((left, right) => right.area - left.area)
        .slice(0, Math.min(candidates.length, count + 24))
        .sort((left, right) => left.x - right.x);

      const largestOnly = pool
        .slice()
        .sort((left, right) => right.area - left.area)
        .slice(0, count);
      const direct = assessMarkerRow(largestOnly, imageWidth, imageHeight);
      if (direct) {
        return direct;
      }

      let best = null;
      for (let firstIndex = 0; firstIndex < pool.length - 1; firstIndex += 1) {
        const first = pool[firstIndex];
        for (let lastIndex = firstIndex + 1; lastIndex < pool.length; lastIndex += 1) {
          const last = pool[lastIndex];
          const span = last.x - first.x;
          if (span < imageWidth * 0.5) {
            continue;
          }
          const spacing = span / (count - 1);
          const markerDiameter = (Math.sqrt(first.area) + Math.sqrt(last.area)) / 2;
          if (spacing < Math.max(4, markerDiameter * 3)) {
            continue;
          }

          const selected = [];
          let searchFailed = false;
          let fitScore = 0;
          for (let markerIndex = 0; markerIndex < count; markerIndex += 1) {
            const expectedX = first.x + spacing * markerIndex;
            const expectedY = first.y + ((last.y - first.y) * markerIndex) / (count - 1);
            const xTolerance = spacing * 0.2;
            const yTolerance = Math.max(imageHeight * 0.055, markerDiameter * 1.75);
            const begin = lowerBoundByX(pool, expectedX - xTolerance);
            let closest = null;
            let closestScore = Number.POSITIVE_INFINITY;
            for (let index = begin; index < pool.length; index += 1) {
              const point = pool[index];
              if (point.x > expectedX + xTolerance) {
                break;
              }
              const yDistance = Math.abs(point.y - expectedY);
              if (yDistance > yTolerance) {
                continue;
              }
              const pointScore =
                Math.abs(point.x - expectedX) / spacing + (yDistance / yTolerance) * 0.1;
              if (pointScore < closestScore) {
                closest = point;
                closestScore = pointScore;
              }
            }
            if (!closest || selected.includes(closest)) {
              searchFailed = true;
              break;
            }
            selected.push(closest);
            fitScore += closestScore;
          }
          if (searchFailed) {
            continue;
          }

          const assessed = assessMarkerRow(selected, imageWidth, imageHeight);
          if (!assessed) {
            continue;
          }
          assessed.score += fitScore / count;
          if (!best || assessed.score < best.score) {
            best = assessed;
          }
        }
      }
      return best;
    }

    function locateSyncMarkers(image) {
      // A low quantile isolates the large, dark sync disks even in a gray or
      // unevenly lit scan. Several passes cover both high-contrast exports and
      // softer JPEG scans.
      const quantiles = [0.03, 0.05, 0.02, 0.08, 0.0125];
      const histogram = redHistogram(image);
      const pixelCount = image.width * image.height;
      const thresholds = Array.from(
        new Set(
          quantiles.map((quantile) =>
            Math.min(190, histogramQuantile(histogram, pixelCount, quantile)),
          ),
        ),
      );
      let best = null;
      let lastCounts = { top: 0, bottom: 0 };

      for (const threshold of thresholds) {
        const topHeap = [];
        const bottomHeap = [];
        let topCount = 0;
        let bottomCount = 0;
        for (const component of darkComponents(image, threshold)) {
          if (component.y < image.height * 0.45) {
            topCount += 1;
            retainMarkerComponent(topHeap, component, MAX_PRECISE_MARKER_CANDIDATES_PER_ROW);
          }
          if (component.y > image.height * 0.55) {
            bottomCount += 1;
            retainMarkerComponent(bottomHeap, component, MAX_PRECISE_MARKER_CANDIDATES_PER_ROW);
          }
        }
        const topCandidates = retainedMarkerComponents(topHeap);
        const bottomCandidates = retainedMarkerComponents(bottomHeap);
        lastCounts = { top: topCount, bottom: bottomCount };

        for (const markerCount of [29, 19]) {
          const top = findMarkerRow(topCandidates, markerCount, image.width, image.height);
          const bottom = findMarkerRow(bottomCandidates, markerCount, image.width, image.height);
          if (!top || !bottom) {
            continue;
          }
          const score = top.score + bottom.score;
          if (!best || score < best.score) {
            best = {
              blockCount: markerCount - 1,
              top: top.points,
              bottom: bottom.points,
              score,
            };
          }
        }
        if (best && best.score < 0.02) {
          break;
        }
      }

      if (!best) {
        throw new DotcodeScanError(
          `Could not find 19 or 29 aligned sync markers in both rows ` +
            `(found ${lastCounts.top} upper and ${lastCounts.bottom} lower candidates)`,
        );
      }
      return best;
    }

    function markerRowSpacing(row) {
      const points = row.points;
      return (
        Math.hypot(
          points[points.length - 1].x - points[0].x,
          points[points.length - 1].y - points[0].y,
        ) /
        (points.length - 1)
      );
    }

    function lowerBoundNumbers(values, target) {
      let low = 0;
      let high = values.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (values[middle] < target) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      return low;
    }

    function upperBoundNumbers(values, target) {
      let low = 0;
      let high = values.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (values[middle] <= target) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      return low;
    }

    function retainBestScored(items, candidate, limit) {
      if (items.length < limit) {
        items.push(candidate);
        return;
      }
      let worstIndex = 0;
      for (let index = 1; index < items.length; index += 1) {
        if (items[index].score > items[worstIndex].score) {
          worstIndex = index;
        }
      }
      if (candidate.score < items[worstIndex].score) {
        items[worstIndex] = candidate;
      }
    }

    function findDirectionalMarkerRows(candidates) {
      const rowsByLength = new Map([
        [19, []],
        [29, []],
      ]);
      const signatureIndicesByLength = new Map([
        [19, new Map()],
        [29, new Map()],
      ]);
      const indexed = candidates.map((point, id) => ({ id, point }));
      const orderedX = indexed.slice().sort((left, right) => left.point.x - right.point.x);
      const orderedY = indexed.slice().sort((left, right) => left.point.y - right.point.y);
      const coordinatesX = orderedX.map((item) => item.point.x);
      const coordinatesY = orderedY.map((item) => item.point.y);

      // Endpoint RANSAC operates only on the coarse preview. A major-axis index
      // keeps every predicted-marker lookup local and avoids a third full scan
      // through the component candidates.
      for (let firstId = 0; firstId < candidates.length - 1; firstId += 1) {
        const first = candidates[firstId];
        for (let secondId = firstId + 1; secondId < candidates.length; secondId += 1) {
          const second = candidates[secondId];
          let deltaX = second.x - first.x;
          let deltaY = second.y - first.y;
          const extent = Math.hypot(deltaX, deltaY);
          if (extent <= 0) {
            continue;
          }

          const useX = Math.abs(deltaX) >= Math.abs(deltaY);
          let startId = firstId;
          let endId = secondId;
          let start = first;
          let end = second;
          if ((useX && deltaX < 0) || (!useX && deltaY < 0)) {
            startId = secondId;
            endId = firstId;
            start = second;
            end = first;
            deltaX = -deltaX;
            deltaY = -deltaY;
          }
          const ordered = useX ? orderedX : orderedY;
          const majorCoordinates = useX ? coordinatesX : coordinatesY;

          for (const markerCount of [29, 19]) {
            const step = extent / (markerCount - 1);
            const endpointSize = Math.max(start.width, start.height, end.width, end.height);
            if (step < Math.max(5, endpointSize * 2.8)) {
              continue;
            }

            const tolerance = Math.max(1.75, step * 0.13);
            const selected = [{ x: start.x, y: start.y }];
            const usedIds = new Set([startId, endId]);
            let fitScore = 0;
            for (let index = 1; index < markerCount - 1; index += 1) {
              const fraction = index / (markerCount - 1);
              const expectedX = start.x + deltaX * fraction;
              const expectedY = start.y + deltaY * fraction;
              const expectedMajor = useX ? expectedX : expectedY;
              const expectedSize =
                Math.max(start.width, start.height) * (1 - fraction) +
                Math.max(end.width, end.height) * fraction;
              const begin = lowerBoundNumbers(majorCoordinates, expectedMajor - tolerance);
              const finish = upperBoundNumbers(majorCoordinates, expectedMajor + tolerance);
              let closest = null;
              for (let candidateIndex = begin; candidateIndex < finish; candidateIndex += 1) {
                const item = ordered[candidateIndex];
                if (usedIds.has(item.id)) {
                  continue;
                }
                const distance = Math.hypot(item.point.x - expectedX, item.point.y - expectedY);
                if (distance > tolerance) {
                  continue;
                }
                const candidateSize = Math.max(item.point.width, item.point.height);
                const sizeRatio = candidateSize / Math.max(1, expectedSize);
                if (sizeRatio < 0.45 || sizeRatio > 2.2) {
                  continue;
                }
                const score = (distance / tolerance) ** 2 + 0.08 * (sizeRatio - 1) ** 2;
                if (!closest || score < closest.score) {
                  closest = { score, item };
                }
              }
              if (!closest) {
                break;
              }
              usedIds.add(closest.item.id);
              selected.push({
                x: closest.item.point.x,
                y: closest.item.point.y,
              });
              fitScore += closest.score;
            }
            if (selected.length !== markerCount - 1) {
              continue;
            }
            selected.push({ x: end.x, y: end.y });

            const steps = [];
            for (let index = 0; index < markerCount - 1; index += 1) {
              steps.push(
                Math.hypot(
                  selected[index + 1].x - selected[index].x,
                  selected[index + 1].y - selected[index].y,
                ),
              );
            }
            const averageStep = steps.reduce((sum, value) => sum + value, 0) / steps.length;
            if (steps.some((value) => value / averageStep < 0.85 || value / averageStep > 1.15)) {
              continue;
            }
            const signature = selected
              .map((point) => `${Math.round(point.x * 2)},${Math.round(point.y * 2)}`)
              .join(";");
            const candidate = {
              points: selected,
              score: fitScore / markerCount,
              signature,
            };
            const rows = rowsByLength.get(markerCount);
            const signatureIndices = signatureIndicesByLength.get(markerCount);
            const existingIndex = signatureIndices.get(signature);
            if (existingIndex !== undefined) {
              if (candidate.score < rows[existingIndex].score) {
                rows[existingIndex] = candidate;
              }
              continue;
            }
            if (rows.length < MAX_DIRECTIONAL_MARKER_ROWS_PER_LENGTH) {
              signatureIndices.set(signature, rows.length);
              rows.push(candidate);
              continue;
            }
            let worstIndex = 0;
            for (let index = 1; index < rows.length; index += 1) {
              if (rows[index].score > rows[worstIndex].score) {
                worstIndex = index;
              }
            }
            if (candidate.score < rows[worstIndex].score) {
              signatureIndices.delete(rows[worstIndex].signature);
              rows[worstIndex] = candidate;
              signatureIndices.set(signature, worstIndex);
            }
          }
        }
      }
      // A 29-marker row also produces several mathematically regular 19-marker
      // windows. Suppress only exact point-corresponding subsets; mere bounding
      // box containment is deliberately insufficient because an unrelated long
      // graphic must not hide a genuine short dotcode.
      const rows = [...rowsByLength.get(29), ...rowsByLength.get(19)];
      return rows
        .filter(
          (row) =>
            row.points.length !== 19 ||
            !rows.some(
              (longer) =>
                longer.points.length === 29 &&
                row.points.every((point) =>
                  longer.points.some(
                    (other) => Math.hypot(point.x - other.x, point.y - other.y) <= 1.5,
                  ),
                ),
            ),
        )
        .sort((left, right) => left.score - right.score);
    }

    function assessDirectionalMarkerPair(first, second) {
      if (first.points.length !== second.points.length) {
        return null;
      }

      const rowGeometry = (points) => {
        const extent = {
          x: points[points.length - 1].x - points[0].x,
          y: points[points.length - 1].y - points[0].y,
        };
        const length = Math.hypot(extent.x, extent.y);
        return {
          extent,
          length,
          unit: length > 0 ? { x: extent.x / length, y: extent.y / length } : { x: 0, y: 0 },
        };
      };

      const firstPoints = first.points;
      let secondPoints = second.points;
      const firstGeometry = rowGeometry(firstPoints);
      let secondGeometry = rowGeometry(secondPoints);
      if (firstGeometry.length <= 0 || secondGeometry.length <= 0) {
        return null;
      }

      const firstUnit = firstGeometry.unit;
      let directionAlignment =
        firstUnit.x * secondGeometry.unit.x + firstUnit.y * secondGeometry.unit.y;
      // Around the 45-degree major-axis boundary, two physically parallel rows
      // can receive opposite canonical directions. Align their marker order
      // before testing parallelism and point-for-point offsets.
      if (directionAlignment < 0) {
        secondPoints = secondPoints.slice().reverse();
        secondGeometry = rowGeometry(secondPoints);
        directionAlignment =
          firstUnit.x * secondGeometry.unit.x + firstUnit.y * secondGeometry.unit.y;
      }
      if (directionAlignment < 0.995) {
        return null;
      }

      const steps = [];
      for (const row of [firstPoints, secondPoints]) {
        for (let index = 0; index < row.length - 1; index += 1) {
          steps.push(Math.hypot(row[index + 1].x - row[index].x, row[index + 1].y - row[index].y));
        }
      }
      const averageStep = steps.reduce((sum, value) => sum + value, 0) / steps.length;
      if (steps.some((value) => value / averageStep < 0.85 || value / averageStep > 1.15)) {
        return null;
      }

      const along = [];
      const across = [];
      for (let index = 0; index < firstPoints.length; index += 1) {
        const offsetX = secondPoints[index].x - firstPoints[index].x;
        const offsetY = secondPoints[index].y - firstPoints[index].y;
        along.push(offsetX * firstUnit.x + offsetY * firstUnit.y);
        across.push(firstUnit.x * offsetY - firstUnit.y * offsetX);
      }
      if (along.some((value) => Math.abs(value) > averageStep * 0.15)) {
        return null;
      }
      if (
        across.some(
          (value) => Math.abs(value) / averageStep < 0.78 || Math.abs(value) / averageStep > 1.22,
        )
      ) {
        return null;
      }
      if (Math.min(...across) < 0 && Math.max(...across) > 0) {
        return null;
      }

      const firstRow = { points: firstPoints, score: first.score };
      const secondRow = { points: secondPoints, score: second.score };
      const [top, bottom] =
        across.reduce((sum, value) => sum + value, 0) > 0
          ? [firstRow, secondRow]
          : [secondRow, firstRow];
      const stepVariation = Math.max(...steps.map((value) => Math.abs(value / averageStep - 1)));
      const alongError =
        along.reduce((sum, value) => sum + Math.abs(value), 0) / (along.length * averageStep);
      const acrossError =
        across.reduce((sum, value) => sum + Math.abs(Math.abs(value) / averageStep - 1), 0) /
        across.length;
      return {
        blockCount: top.points.length - 1,
        top: top.points,
        bottom: bottom.points,
        score:
          top.score +
          bottom.score +
          (1 - directionAlignment) +
          stepVariation +
          alongError +
          acrossError,
      };
    }

    function sameMarkerGrid(left, right) {
      if (left.blockCount !== right.blockCount) {
        return false;
      }
      const leftSpacing =
        (markerRowSpacing({ points: left.top }) + markerRowSpacing({ points: left.bottom })) / 2;
      const rightSpacing =
        (markerRowSpacing({ points: right.top }) + markerRowSpacing({ points: right.bottom })) / 2;
      if (
        !Number.isFinite(leftSpacing) ||
        !Number.isFinite(rightSpacing) ||
        leftSpacing <= 0 ||
        rightSpacing <= 0 ||
        leftSpacing / rightSpacing < 0.8 ||
        leftSpacing / rightSpacing > 1.25
      ) {
        return false;
      }

      const spacing = (leftSpacing + rightSpacing) / 2;
      const matchesOrientation = (swapRows, reverseRows) => {
        let totalDistance = 0;
        let maximumDistance = 0;
        let pointCount = 0;
        const rightRows = swapRows ? [right.bottom, right.top] : [right.top, right.bottom];
        for (const [leftRow, rightRow] of [
          [left.top, rightRows[0]],
          [left.bottom, rightRows[1]],
        ]) {
          for (let index = 0; index < leftRow.length; index += 1) {
            const rightIndex = reverseRows ? rightRow.length - 1 - index : index;
            const distance =
              Math.hypot(
                leftRow[index].x - rightRow[rightIndex].x,
                leftRow[index].y - rightRow[rightIndex].y,
              ) / spacing;
            totalDistance += distance;
            maximumDistance = Math.max(maximumDistance, distance);
            pointCount += 1;
          }
        }
        return maximumDistance <= 0.45 && totalDistance / pointCount <= 0.2;
      };

      // Reversing a row direction also reverses its local normal, which can
      // swap the grid's top/bottom labels. Treat all equivalent orientations as
      // one geometry so threshold jitter near 45 degrees cannot duplicate it.
      return (
        matchesOrientation(false, false) ||
        matchesOrientation(false, true) ||
        matchesOrientation(true, false) ||
        matchesOrientation(true, true)
      );
    }

    function deduplicateMarkerGrids(grids) {
      const unique = [];
      for (const grid of grids) {
        const existingIndex = unique.findIndex((existing) => sameMarkerGrid(existing, grid));
        if (existingIndex === -1) {
          unique.push(grid);
          continue;
        }
        const existing = unique[existingIndex];
        if (grid.score < existing.score) {
          unique[existingIndex] = grid;
        }
      }
      return unique;
    }

    function scaleMarkerGrid(grid, scaleX, scaleY) {
      if (scaleX === 1 && scaleY === 1) {
        return grid;
      }
      const scalePoints = (points) =>
        points.map((point) => ({
          x: point.x * scaleX,
          y: point.y * scaleY,
        }));
      return {
        blockCount: grid.blockCount,
        top: scalePoints(grid.top),
        bottom: scalePoints(grid.bottom),
        score: grid.score,
      };
    }

    function sampleRedOrWhite(image, x, y) {
      if (x < 0 || y < 0 || x > image.width - 1 || y > image.height - 1) {
        return 255;
      }
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const y1 = Math.min(image.height - 1, y0 + 1);
      const xFraction = x - x0;
      const yFraction = y - y0;
      const topLeft = redAt(image, y0 * image.width + x0);
      const topRight = redAt(image, y0 * image.width + x1);
      const bottomLeft = redAt(image, y1 * image.width + x0);
      const bottomRight = redAt(image, y1 * image.width + x1);
      return Math.round(
        topLeft * (1 - xFraction) * (1 - yFraction) +
          topRight * xFraction * (1 - yFraction) +
          bottomLeft * (1 - xFraction) * yFraction +
          bottomRight * xFraction * yFraction,
      );
    }

    function cubicWeight(distance) {
      const value = Math.abs(distance);
      if (value < 1) {
        return (1.5 * value - 2.5) * value * value + 1;
      }
      if (value < 2) {
        return ((-0.5 * value + 2.5) * value - 4) * value + 2;
      }
      return 0;
    }

    function sampleRedBicubicOrWhite(image, x, y) {
      const baseX = Math.floor(x);
      const baseY = Math.floor(y);
      let weighted = 0;
      let totalWeight = 0;
      for (let sampleY = baseY - 1; sampleY <= baseY + 2; sampleY += 1) {
        const yWeight = cubicWeight(y - sampleY);
        for (let sampleX = baseX - 1; sampleX <= baseX + 2; sampleX += 1) {
          const weight = cubicWeight(x - sampleX) * yWeight;
          const value =
            sampleX < 0 || sampleY < 0 || sampleX >= image.width || sampleY >= image.height
              ? 255
              : redAt(image, sampleY * image.width + sampleX);
          weighted += value * weight;
          totalWeight += weight;
        }
      }
      return Math.round(Math.max(0, Math.min(255, weighted / totalWeight)));
    }

    function normalizeMarkerGrid(image, coarseGrid) {
      const directionX =
        (coarseGrid.top[coarseGrid.blockCount].x -
          coarseGrid.top[0].x +
          coarseGrid.bottom[coarseGrid.blockCount].x -
          coarseGrid.bottom[0].x) /
        2;
      const directionY =
        (coarseGrid.top[coarseGrid.blockCount].y -
          coarseGrid.top[0].y +
          coarseGrid.bottom[coarseGrid.blockCount].y -
          coarseGrid.bottom[0].y) /
        2;
      const directionLength = Math.hypot(directionX, directionY);
      if (directionLength <= 0) {
        throw new DotcodeScanError("The dot-code marker grid has no usable direction");
      }
      const unitX = directionX / directionLength;
      const unitY = directionY / directionLength;
      const normalX = -unitY;
      const normalY = unitX;

      const steps = [];
      for (const row of [coarseGrid.top, coarseGrid.bottom]) {
        for (let index = 0; index < row.length - 1; index += 1) {
          steps.push(Math.hypot(row[index + 1].x - row[index].x, row[index + 1].y - row[index].y));
        }
      }
      const averageStep = steps.reduce((sum, value) => sum + value, 0) / steps.length;
      const origin = coarseGrid.top[0];
      const points = [...coarseGrid.top, ...coarseGrid.bottom];
      const along = points.map(
        (point) => (point.x - origin.x) * unitX + (point.y - origin.y) * unitY,
      );
      const across = points.map(
        (point) => (point.x - origin.x) * normalX + (point.y - origin.y) * normalY,
      );
      const marginAlong = averageStep * 0.6;
      const marginAcross = averageStep * 0.4;
      const minimumAlong = Math.min(...along) - marginAlong;
      const minimumAcross = Math.min(...across) - marginAcross;
      const roiWidth = Math.max(
        35,
        Math.ceil(Math.max(...along) - Math.min(...along) + 2 * marginAlong),
      );
      const roiHeight = Math.max(
        35,
        Math.ceil(Math.max(...across) - Math.min(...across) + 2 * marginAcross),
      );
      const roiPixelCount = roiWidth * roiHeight;
      if (!Number.isSafeInteger(roiPixelCount) || roiPixelCount > MAX_NORMALIZED_PIXELS) {
        throw new DotcodeScanError("The normalized dot-code region is too large to decode safely");
      }

      const sourceOriginX = origin.x + minimumAlong * unitX + minimumAcross * normalX;
      const sourceOriginY = origin.y + minimumAlong * unitY + minimumAcross * normalY;
      const data = new Uint8Array(roiPixelCount);
      for (let y = 0; y < roiHeight; y += 1) {
        const rowSourceX = sourceOriginX + y * normalX;
        const rowSourceY = sourceOriginY + y * normalY;
        for (let x = 0; x < roiWidth; x += 1) {
          // Bicubic affine sampling keeps small dot centers distinct from paper
          // texture; bilinear sampling can turn a light cell into a false dot.
          data[y * roiWidth + x] = sampleRedBicubicOrWhite(
            image,
            rowSourceX + x * unitX,
            rowSourceY + x * unitY,
          );
        }
      }
      const normalizedImage = {
        width: roiWidth,
        height: roiHeight,
        data,
        redOnly: true,
        sourceImage: image,
        toSourcePoint: (point) => ({
          x: sourceOriginX + point.x * unitX + point.y * normalX,
          y: sourceOriginY + point.x * unitY + point.y * normalY,
        }),
      };
      const toNormalizedPoints = (markerPoints) =>
        markerPoints.map((point) => ({
          x: (point.x - origin.x) * unitX + (point.y - origin.y) * unitY - minimumAlong,
          y: (point.x - origin.x) * normalX + (point.y - origin.y) * normalY - minimumAcross,
        }));
      const coarseNormalized = {
        blockCount: coarseGrid.blockCount,
        top: toNormalizedPoints(coarseGrid.top),
        bottom: toNormalizedPoints(coarseGrid.bottom),
        score: coarseGrid.score,
      };

      try {
        const refined = locateSyncMarkers(normalizedImage);
        if (refined.blockCount !== coarseGrid.blockCount) {
          throw new DotcodeScanError("The precise marker count differs from the coarse grid");
        }
        return {
          image: normalizedImage,
          markers: refined,
          coarseFallback: coarseNormalized,
          center: markerGridCenter(coarseGrid),
        };
      } catch (error) {
        if (!(error instanceof DotcodeScanError)) {
          throw error;
        }
        return {
          image: normalizedImage,
          markers: coarseNormalized,
          center: markerGridCenter(coarseGrid),
        };
      }
    }

    function upscaleNormalizedCandidate(candidate) {
      const scale = 2;
      const width = candidate.image.width * scale;
      const height = candidate.image.height * scale;
      const pixelCount = width * height;
      if (
        width > MAX_IMAGE_DIMENSION ||
        height > MAX_IMAGE_DIMENSION ||
        !Number.isSafeInteger(pixelCount) ||
        pixelCount > MAX_NORMALIZED_PIXELS
      ) {
        return null;
      }

      const data = new Uint8Array(pixelCount);
      for (let y = 0; y < height; y += 1) {
        const sourceY = (y + 0.5) / scale - 0.5;
        for (let x = 0; x < width; x += 1) {
          const sourceX = (x + 0.5) / scale - 0.5;
          data[y * width + x] = sampleRedOrWhite(candidate.image, sourceX, sourceY);
        }
      }
      const image = {
        width,
        height,
        data,
        redOnly: true,
        sourceImage: candidate.image.sourceImage || candidate.image,
        toSourcePoint: (point) => {
          const unscaled = {
            x: (point.x + 0.5) / scale - 0.5,
            y: (point.y + 0.5) / scale - 0.5,
          };
          return candidate.image.toSourcePoint ? candidate.image.toSourcePoint(unscaled) : unscaled;
        },
      };
      const scaleGrid = (grid) => {
        if (!grid) {
          return null;
        }
        const scalePoints = (points) =>
          points.map((point) => ({
            x: (point.x + 0.5) * scale - 0.5,
            y: (point.y + 0.5) * scale - 0.5,
          }));
        return {
          blockCount: grid.blockCount,
          top: scalePoints(grid.top),
          bottom: scalePoints(grid.bottom),
          score: grid.score,
        };
      };
      const scaledMarkers = scaleGrid(candidate.markers);
      let markers = scaledMarkers;
      try {
        const refined = locateSyncMarkers(image);
        if (refined.blockCount === candidate.markers.blockCount) {
          markers = refined;
        }
      } catch (error) {
        if (!(error instanceof DotcodeScanError)) {
          throw error;
        }
      }
      return {
        image,
        markers,
        coarseFallback:
          markers === scaledMarkers ? scaleGrid(candidate.coarseFallback) : scaledMarkers,
        center: candidate.center,
      };
    }

    function fullScanMarkerThresholds(image) {
      const histogram = redHistogram(image);
      const pixelCount = image.width * image.height;
      const dark = histogramQuantile(histogram, pixelCount, 0.005);
      const light = histogramQuantile(histogram, pixelCount, 0.9);
      if (light - dark < 40) {
        throw new DotcodeScanError("The dot-code image has insufficient contrast");
      }
      return Array.from(
        new Set(
          [0.28, 0.34, 0.22, 0.4, 0.16, 0.46, 0.58, 0.7].map((ratio) =>
            Math.round(dark + (light - dark) * ratio),
          ),
        ),
      );
    }

    function markerGridCenter(grid) {
      const points = [...grid.top, ...grid.bottom];
      return {
        x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
        y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
      };
    }

    function locateSyncMarkerGrids(image) {
      const grids = [];
      const thresholds = fullScanMarkerThresholds(image);
      const scale = Math.min(image.width, image.height);
      // Full-card previews can shrink sync disks to two pixels and lighten them
      // through averaging, so include small components and brighter thresholds.
      const minimumMarkerDimension = 2;
      const maximumMarkerDimension = Math.min(80, Math.max(7, Math.round(scale * 0.03)));

      for (const threshold of thresholds) {
        const candidateHeap = [];
        for (const component of darkComponents(image, threshold)) {
          if (
            component.width >= minimumMarkerDimension &&
            component.height >= minimumMarkerDimension &&
            component.width <= maximumMarkerDimension &&
            component.height <= maximumMarkerDimension &&
            component.width / component.height >= 0.65 &&
            component.width / component.height <= 1.55 &&
            component.area / (component.width * component.height) >= 0.45
          ) {
            // Sync disks rank among the larger compact components. Retaining a
            // bounded heap avoids materializing and sorting every speckle while
            // also bounding the quadratic endpoint search.
            retainMarkerComponent(candidateHeap, component, MAX_COARSE_MARKER_CANDIDATES);
          }
        }
        const candidates = retainedMarkerComponents(candidateHeap);

        const rows = findDirectionalMarkerRows(candidates);
        const thresholdGrids = [];
        for (let firstIndex = 0; firstIndex < rows.length - 1; firstIndex += 1) {
          for (let secondIndex = firstIndex + 1; secondIndex < rows.length; secondIndex += 1) {
            const assessed = assessDirectionalMarkerPair(rows[firstIndex], rows[secondIndex]);
            if (assessed) {
              retainBestScored(thresholdGrids, assessed, MAX_MARKER_GRIDS_PER_THRESHOLD);
            }
          }
        }
        grids.push(...thresholdGrids);
      }

      const unique = deduplicateMarkerGrids(grids);
      if (unique.length > MAX_LOCATED_MARKER_GRIDS) {
        unique.sort((left, right) => left.score - right.score);
        unique.length = MAX_LOCATED_MARKER_GRIDS;
      }
      return unique.sort((left, right) => {
        const leftCenter = markerGridCenter(left);
        const rightCenter = markerGridCenter(right);
        return leftCenter.y - rightCenter.y || leftCenter.x - rightCenter.x;
      });
    }

    function gridPosition(top, bottom, block, logicalX, logicalY) {
      const horizontal = (logicalX - 4) / 35;
      const vertical = (logicalY - 4) / 35;
      const topX = top[block].x * (1 - horizontal) + top[block + 1].x * horizontal;
      const topY = top[block].y * (1 - horizontal) + top[block + 1].y * horizontal;
      const bottomX = bottom[block].x * (1 - horizontal) + bottom[block + 1].x * horizontal;
      const bottomY = bottom[block].y * (1 - horizontal) + bottom[block + 1].y * horizontal;
      return {
        x: topX * (1 - vertical) + bottomX * vertical,
        y: topY * (1 - vertical) + bottomY * vertical,
      };
    }

    function nearestRed(image, x, y) {
      const pixelX = Math.max(0, Math.min(image.width - 1, Math.round(x)));
      const pixelY = Math.max(0, Math.min(image.height - 1, Math.round(y)));
      return redAt(image, pixelY * image.width + pixelX);
    }

    function estimateDemodulationThresholds(image) {
      const histogram = redHistogram(image);
      const pixelCount = image.width * image.height;
      const dark = histogramQuantile(histogram, pixelCount, 0.005);
      const light = histogramQuantile(histogram, pixelCount, 0.9);
      if (light <= dark) {
        return [];
      }
      return Array.from(
        new Set(
          [0.52, 0.58, 0.64, 0.7, 0.76, 0.82].map((ratio) =>
            Math.round(dark + (light - dark) * ratio),
          ),
        ),
      );
    }

    function correctAndValidateRaw(raw, blockCount) {
      const expectedSize = blockCount * BYTES_PER_BLOCK;
      if (raw.length !== expectedSize) {
        throw new DotcodeScanError(`Decoded RAW has ${raw.length} bytes; expected ${expectedSize}`);
      }

      const headerWord = new Uint8Array(24);
      for (let block = 0; block < 12; block += 1) {
        headerWord[block * 2] = raw[block * BYTES_PER_BLOCK];
        headerWord[block * 2 + 1] = raw[block * BYTES_PER_BLOCK + 1];
      }
      let correctedHeader;
      try {
        correctedHeader = correctStoredCodeword(headerWord, RS_PARITY_SIZE).data;
      } catch (error) {
        if (error instanceof DotcodeScanError) {
          throw new DotcodeScanError(
            `The scan does not contain a valid e-Reader header: ${error.message}`,
          );
        }
        throw error;
      }

      const expectedType = blockCount === LONG_BLOCK_COUNT ? 0x03 : 0x02;
      const expectedStartAddress = blockCount === LONG_BLOCK_COUNT ? 0x19 : 0x01;
      const interleaveWidth = blockCount === LONG_BLOCK_COUNT ? 44 : 28;
      if (
        correctedHeader[0] !== 0x00 ||
        correctedHeader[1] !== expectedType ||
        correctedHeader[2] !== 0x00 ||
        correctedHeader[3] !== expectedStartAddress ||
        correctedHeader[4] !== 0x40 ||
        correctedHeader[5] !== 0x10 ||
        correctedHeader[6] !== 0x00 ||
        correctedHeader[7] !== interleaveWidth
      ) {
        throw new DotcodeScanError(
          "The scan's corrected header is not a Nintendo e-Reader dotcode",
        );
      }

      const correctedRaw = new Uint8Array(raw);
      for (let block = 0; block < blockCount; block += 1) {
        correctedRaw[block * BYTES_PER_BLOCK] = correctedHeader[(block * 2) % 24];
        correctedRaw[block * BYTES_PER_BLOCK + 1] = correctedHeader[(block * 2 + 1) % 24];
      }

      const interleaved = layout.readBlockData(correctedRaw, interleaveWidth * RS_CODEWORD_SIZE);
      const words = layout.deinterleave(interleaved, interleaveWidth, RS_CODEWORD_SIZE);

      for (let column = 0; column < interleaveWidth; column += 1) {
        const codeword = words.subarray(column * RS_CODEWORD_SIZE, (column + 1) * RS_CODEWORD_SIZE);
        let corrected;
        try {
          corrected = correctStoredCodeword(codeword, RS_PARITY_SIZE).data;
        } catch (error) {
          if (error instanceof DotcodeScanError) {
            throw new DotcodeScanError(
              `Dotcode data column ${column + 1}/${interleaveWidth} is unreadable: ${error.message}`,
            );
          }
          throw error;
        }
        words.set(corrected, column * RS_CODEWORD_SIZE);
      }
      layout.writeBlockData(correctedRaw, layout.interleave(words, RS_CODEWORD_SIZE));
      return correctedRaw;
    }

    function decodeOrientation(image, top, bottom, blockCount, thresholds) {
      const sampled = sampleDataDots(image, top, bottom, blockCount);

      // Bootstrap the protected data before calibrating the unprotected cells.
      for (const threshold of thresholds) {
        try {
          const raw = correctAndValidateRaw(
            thresholdDemodulate(sampled.blocks, threshold),
            blockCount,
          );
          return refineDecodedRaw(image, top, bottom, raw);
        } catch (error) {
          if (!(error instanceof DotcodeScanError)) {
            throw error;
          }
        }
      }

      const levels = estimateDotLevels(sampled.histogram, blockCount * BITS_PER_BLOCK);
      const raw = correctAndValidateRaw(
        softDemodulate(sampled.blocks, levels.dark, levels.light),
        blockCount,
      );
      return refineDecodedRaw(image, top, bottom, raw);
    }

    function refineDecodedRaw(image, top, bottom, raw) {
      return sampling.refineRaw(
        image.sourceImage || image,
        image.toSourcePoint ? top.map(image.toSourcePoint) : top,
        image.toSourcePoint ? bottom.map(image.toSourcePoint) : bottom,
        raw,
      );
    }

    function decodeMarkerGrid(image, markers) {
      const normalTop = markers.top;
      const normalBottom = markers.bottom;
      const reversedTop = normalTop.slice().reverse();
      const reversedBottom = normalBottom.slice().reverse();
      const orientations = [
        [normalTop, normalBottom],
        [reversedBottom, reversedTop],
        [reversedTop, reversedBottom],
        [normalBottom, normalTop],
      ];

      const errors = [];
      const thresholds = estimateDemodulationThresholds(image);
      for (const [top, bottom] of orientations) {
        try {
          return decodeOrientation(image, top, bottom, markers.blockCount, thresholds);
        } catch (error) {
          if (!(error instanceof DotcodeScanError)) {
            throw error;
          }
          errors.push(error.message);
        }
      }
      throw new DotcodeScanError(
        `The detected strip could not be decoded in any orientation. ${errors[0]}`,
      );
    }

    function appendDecodedApplication(decoded, result, center) {
      const { raw, quality } = result;
      const { app: application, cardType } = rawCodec.decodeRawDotcodeDetails(
        raw,
        "The corrected strip",
      );
      if (
        decoded.some(
          (known) =>
            known.cardType === cardType && binary.bytesEqual(known.application, application),
        )
      ) {
        return;
      }
      decoded.push({ raw, quality, application, cardType, center });
    }

    function horizontalPreciseFallbackImage(image) {
      if (image.width >= image.height) {
        return image;
      }
      const width = image.height;
      const height = image.width;
      const data = new Uint8Array(width * height);
      for (let sourceY = 0; sourceY < image.height; sourceY += 1) {
        for (let sourceX = 0; sourceX < image.width; sourceX += 1) {
          data[sourceX * width + (width - 1 - sourceY)] = redAt(
            image,
            sourceY * image.width + sourceX,
          );
        }
      }
      return { width, height, data, redOnly: true };
    }

    function decodeLocatedDotcodeImages(rgba) {
      const locator = locatorImage(rgba);
      const errors = [];
      let coarseGrids = [];
      try {
        coarseGrids = locateSyncMarkerGrids(locator.image).map((grid) =>
          scaleMarkerGrid(grid, locator.scaleX, locator.scaleY),
        );
      } catch (error) {
        if (!(error instanceof DotcodeScanError)) {
          throw error;
        }
        errors.push(error.message);
      }
      const decoded = [];
      let recoverySession;
      let recoveryAttempts = 0;
      for (const grid of coarseGrids) {
        let candidate;
        try {
          candidate = normalizeMarkerGrid(rgba, grid);
        } catch (error) {
          if (!(error instanceof DotcodeScanError)) {
            throw error;
          }
          errors.push(error.message);
          continue;
        }
        let decodedCandidate = false;
        let resolutionCandidate = candidate;
        for (let resolutionAttempt = 0; resolutionAttempt < 2; resolutionAttempt += 1) {
          const attempts = resolutionCandidate.coarseFallback
            ? [resolutionCandidate.markers, resolutionCandidate.coarseFallback]
            : [resolutionCandidate.markers];
          for (const attempt of attempts) {
            try {
              appendDecodedApplication(
                decoded,
                decodeMarkerGrid(resolutionCandidate.image, attempt),
                resolutionCandidate.center,
              );
              decodedCandidate = true;
              break;
            } catch (error) {
              if (!(error instanceof DotcodeScanError)) {
                throw error;
              }
              errors.push(error.message);
            }
          }
          if (decodedCandidate) {
            break;
          }
          resolutionCandidate =
            resolutionAttempt === 0 ? upscaleNormalizedCandidate(candidate) : null;
          if (!resolutionCandidate) {
            break;
          }
        }
        if (!decodedCandidate) {
          const markers = candidate.markers;
          const top = markers.top.map(candidate.image.toSourcePoint);
          const bottom = markers.bottom.map(candidate.image.toSourcePoint);
          const pitch = Math.hypot(top[1].x - top[0].x, top[1].y - top[0].y) / 35;
          if (pitch >= 1.25 && pitch <= 2.75 && recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
            recoverySession ||= recovery.createSession(rgba);
            const reversedTop = top.slice().reverse();
            const reversedBottom = bottom.slice().reverse();
            for (const [first, second] of [
              [top, bottom], [reversedBottom, reversedTop],
              [reversedTop, reversedBottom], [bottom, top],
            ]) {
              if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) break;
              recoveryAttempts++;
              try {
                const result = recoverySession.decode(first, second);
                if (!result) continue;
                appendDecodedApplication(decoded, result, candidate.center);
                break;
              } catch (error) {
                errors.push(error.message);
              }
            }
          }
        }
      }

      // Downsampling can hide markers in tightly cropped strips; retry at full resolution.
      const fallbackAspect = Math.max(rgba.width, rgba.height) / Math.min(rgba.width, rgba.height);
      if (decoded.length === 0 && fallbackAspect >= 8) {
        const preciseImage = horizontalPreciseFallbackImage(rgba);
        try {
          appendDecodedApplication(
            decoded,
            decodeMarkerGrid(preciseImage, locateSyncMarkers(preciseImage)),
            { x: rgba.width / 2, y: rgba.height / 2 },
          );
        } catch (error) {
          if (!(error instanceof DotcodeScanError)) {
            throw error;
          }
          errors.push(error.message);
        }
      }

      if (decoded.length === 0) {
        throw new DotcodeScanError(
          coarseGrids.length === 0
            ? errors[0] ||
              "Could not find any paired e-Reader synchronization-marker rows in the image"
            : `The detected strip${coarseGrids.length === 1 ? "" : "s"} could not be decoded. ` +
              (errors[0] || "No valid Nintendo e-Reader data was found."),
        );
      }
      return decoded.sort(
        (left, right) => left.center.y - right.center.y || left.center.x - right.center.x,
      );
    }

    function decodeDotcodeImages(image, options = {}) {
      const rgba = asRgbaImage(image);
      const decoded = decodeLocatedDotcodeImages(rgba);
      if (typeof options?.onStripDecoded === "function") {
        for (const { raw, quality } of decoded) options.onStripDecoded(raw, quality);
      }
      return decoded.map((entry) => entry.raw);
    }

    function correctReedSolomon64_48(codeword) {
      const bytes = asByteArray(codeword, "RS(64,48) codeword");
      if (bytes.length !== RS_CODEWORD_SIZE) {
        throw new TypeError(`RS(64,48) codeword must contain exactly ${RS_CODEWORD_SIZE} bytes`);
      }
      return correctStoredCodeword(bytes, RS_PARITY_SIZE).data;
    }

    const rawCodec = rawModule.createRawCodec(DotcodeScanError);

    function correctStoredCodeword(input, paritySize = RS_PARITY_SIZE) {
      try {
        return reedSolomon.correctStoredCodeword(input, paritySize);
      } catch (error) {
        if (error instanceof reedSolomon.ReedSolomonError)
          throw new DotcodeScanError(error.message);
        throw error;
      }
    }

    function sampleDataDots(image, top, bottom, blockCount) {
      const blocks = [];
      const histogram = new Uint32Array(256);
      for (let block = 0; block < blockCount; block += 1) {
        const values = new Uint8Array(BITS_PER_BLOCK);
        for (let index = 0; index < BITS_PER_BLOCK; index += 1) {
          const [x, y] = layout.dataPosition(index);
          const position = gridPosition(top, bottom, block, x, y);
          const value = nearestRed(image, position.x, position.y);
          values[index] = value;
          histogram[value] += 1;
        }
        blocks.push(values);
      }
      return { blocks, histogram };
    }

    function estimateDotLevels(histogram, count) {
      const quantile = (fraction) => {
        const rank = Math.floor(count * fraction);
        let cumulative = 0;
        for (let value = 0; value < histogram.length; value += 1) {
          cumulative += histogram[value];
          if (cumulative > rank) return value;
        }
        return Number.NaN;
      };
      let dark = quantile(0.2);
      let light = quantile(0.8);
      for (let iteration = 0; iteration < 20; iteration += 1) {
        let darkSum = 0;
        let darkCount = 0;
        let lightSum = 0;
        let lightCount = 0;
        for (let value = 0; value < histogram.length; value += 1) {
          const frequency = histogram[value];
          if (Math.abs(value - dark) <= Math.abs(value - light)) {
            darkSum += value * frequency;
            darkCount += frequency;
          } else {
            lightSum += value * frequency;
            lightCount += frequency;
          }
        }
        if (darkCount === 0 || lightCount === 0) break;
        const nextDark = darkSum / darkCount;
        const nextLight = lightSum / lightCount;
        const change = Math.abs(nextDark - dark) + Math.abs(nextLight - light);
        dark = nextDark;
        light = nextLight;
        if (change < 0.01) break;
      }
      if (!Number.isFinite(dark) || !Number.isFinite(light) || light - dark < 18) {
        throw new DotcodeScanError(
          "The dotcode scan does not have enough contrast to distinguish dots",
        );
      }
      return { dark, light };
    }

    function demodulate(blockSamples, fillCosts) {
      const raw = new Uint8Array(blockSamples.length * BYTES_PER_BLOCK);
      const darkCosts = new Float64Array(5);
      const lightCosts = new Float64Array(5);
      let rawOffset = 0;
      for (const samples of blockSamples) {
        let highNibble = 0;
        for (let symbolIndex = 0; symbolIndex < BYTES_PER_BLOCK * 2; symbolIndex += 1) {
          fillCosts(samples, symbolIndex * 5, darkCosts, lightCosts);
          let bestNibble = 0;
          let bestCost = Number.POSITIVE_INFINITY;
          for (let nibble = 0; nibble < MODULATION_TABLE.length; nibble += 1) {
            const symbol = MODULATION_TABLE[nibble];
            let cost = 0;
            for (let bit = 0; bit < 5; bit += 1) {
              cost += (symbol >>> (4 - bit)) & 1 ? darkCosts[bit] : lightCosts[bit];
            }
            if (cost < bestCost) {
              bestCost = cost;
              bestNibble = nibble;
            }
          }
          if (symbolIndex % 2 === 0) highNibble = bestNibble << 4;
          else raw[rawOffset++] = highNibble | bestNibble;
        }
      }
      return raw;
    }

    function thresholdDemodulate(blockSamples, threshold) {
      return demodulate(blockSamples, (samples, offset, darkCosts, lightCosts) => {
        for (let bit = 0; bit < 5; bit += 1) {
          const value = samples[offset + bit] - threshold;
          darkCosts[bit] = value;
          lightCosts[bit] = -value;
        }
      });
    }

    function softDemodulate(blockSamples, dark, light) {
      return demodulate(blockSamples, (samples, offset, darkCosts, lightCosts) => {
        for (let bit = 0; bit < 5; bit += 1) {
          const darkDifference = samples[offset + bit] - dark;
          const lightDifference = samples[offset + bit] - light;
          darkCosts[bit] = darkDifference * darkDifference;
          lightCosts[bit] = lightDifference * lightDifference;
        }
      });
    }

    return Object.freeze({
      DotcodeScanError,
      decodeDotcodeImages,
      inspectEncodedImageDimensions,
      correctReedSolomon64_48,
      LONG_RAW_SIZE: LONG_BLOCK_COUNT * BYTES_PER_BLOCK,
      SHORT_RAW_SIZE: SHORT_BLOCK_COUNT * BYTES_PER_BLOCK,
    });
  },
);
