(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./binary.js"),
      require("./dotcode_layout.js"),
    );
  } else {
    root.EReaderPngRenderer = factory(
      root.EReaderBinary,
      root.EReaderDotcodeLayout,
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (binary, layout) {
  "use strict";

  const { asciiBytes, concatBytes, crc32 } = binary;
  const PNG_RENDER_DPI = 1200;
  // raw2bmp's 300 dpi logical grid puts every dot on whole pixels at 1200 dpi.
  const PNG_RENDER_SCALE = 4;
  const DOTCODE_DATA_DOT_SIZE = 3; // PNG_RENDER_SCALE / 2;
  const DOTCODE_DATA_DOT_RADIUS = DOTCODE_DATA_DOT_SIZE / 2;
  const DOTCODE_SYNC_MARKER_DIAMETER = 5 * PNG_RENDER_SCALE;
  const constants = Object.freeze({
    PNG_RENDER_DPI,
    PNG_RENDER_SCALE,
    DOTCODE_DATA_DOT_SIZE,
    DOTCODE_DATA_DOT_RADIUS,
  });

  function pngChunk(type, data) {
    const chunk = new Uint8Array(data.length + 12);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(asciiBytes(type), 4);
    chunk.set(data, 8);
    view.setUint32(data.length + 8, crc32(chunk.subarray(4, data.length + 8)));
    return chunk;
  }

  function createPngRenderer(patcher) {
    async function rawDotcodeToPng(rawInput, label = "RAW input", options = {}) {
      const raw = patcher.asBytes(rawInput, "RAW input");
      patcher.inspectScanCard(raw, label);
      const dotSize =
        options && options.dotSize !== undefined ? Number(options.dotSize) : DOTCODE_DATA_DOT_SIZE;
      if (!Number.isInteger(dotSize) || dotSize <= 0 || dotSize >= PNG_RENDER_SCALE) {
        throw new patcher.PatcherError(
          `dotSize must be an integer greater than 0 and smaller than ${PNG_RENDER_SCALE}`,
        );
      }
      const configuredDotRadius =
        options && options.dotRadius !== undefined
          ? Number(options.dotRadius)
          : DOTCODE_DATA_DOT_RADIUS;
      if (!Number.isFinite(configuredDotRadius) || configuredDotRadius < 0) {
        throw new patcher.PatcherError("dotRadius must be a finite number greater than or equal to 0");
      }
      const dotCornerRadius = Math.min(dotSize / 2, configuredDotRadius);
      if (typeof CompressionStream !== "function") {
        throw new Error("This browser does not support PNG export compression.");
      }
      const { blockCount, logicalWidth, logicalHeight, dots } = layout.createDotcodeGeometry(raw);
      const width = logicalWidth * PNG_RENDER_SCALE;
      const height = logicalHeight * PNG_RENDER_SCALE;
      const rowBytes = 1 + Math.ceil(width / 8);
      const pixels = new Uint8Array(rowBytes * height);
      const setPixel = (x, y) => {
        pixels[y * rowBytes + 1 + (x >>> 3)] |= 0x80 >>> (x & 7);
      };

      const dotInset = Math.floor((PNG_RENDER_SCALE - dotSize) / 2);
      const dotPixels = [];
      for (let y = 0; y < dotSize; y += 1) {
        for (let x = 0; x < dotSize; x += 1) {
          const dx = Math.max(dotCornerRadius - Math.min(x + 0.5, dotSize - x - 0.5), 0);
          const dy = Math.max(dotCornerRadius - Math.min(y + 0.5, dotSize - y - 0.5), 0);
          if (dx * dx + dy * dy <= dotCornerRadius * dotCornerRadius) dotPixels.push([x, y]);
        }
      }
      for (const coordinate of dots) {
        const left = (coordinate % logicalWidth) * PNG_RENDER_SCALE + dotInset;
        const top = Math.floor(coordinate / logicalWidth) * PNG_RENDER_SCALE + dotInset;
        for (const [x, y] of dotPixels) setPixel(left + x, top + y);
      }

      const radius = DOTCODE_SYNC_MARKER_DIAMETER / 2;
      for (let marker = 0; marker <= blockCount; marker += 1) {
        const centerX = (marker * 35 + 4.5) * PNG_RENDER_SCALE;
        for (const centerY of [4.5 * PNG_RENDER_SCALE, 39.5 * PNG_RENDER_SCALE]) {
          for (let y = Math.floor(centerY - radius); y < centerY + radius; y += 1) {
            for (let x = Math.floor(centerX - radius); x < centerX + radius; x += 1) {
              if ((x + 0.5 - centerX) ** 2 + (y + 0.5 - centerY) ** 2 <= radius ** 2) {
                setPixel(x, y);
              }
            }
          }
        }
      }

      const header = new Uint8Array(13);
      const headerView = new DataView(header.buffer);
      headerView.setUint32(0, width);
      headerView.setUint32(4, height);
      header[8] = 1;
      header[9] = 3;
      const density = new Uint8Array(9);
      const densityView = new DataView(density.buffer);
      const pixelsPerMeter = Math.round(PNG_RENDER_DPI / 0.0254);
      densityView.setUint32(0, pixelsPerMeter);
      densityView.setUint32(4, pixelsPerMeter);
      density[8] = 1;
      const compressed = new Uint8Array(
        await new Response(
          new Blob([pixels]).stream().pipeThrough(new CompressionStream("deflate")),
        ).arrayBuffer(),
      );
      return concatBytes(
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk("IHDR", header),
        pngChunk("PLTE", new Uint8Array([255, 255, 255, 0, 0, 0])),
        pngChunk("pHYs", density),
        pngChunk("IDAT", compressed),
        pngChunk("IEND", new Uint8Array()),
      );
    }

    return rawDotcodeToPng;
  }

  return Object.freeze({ constants, createPngRenderer });
});
