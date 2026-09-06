(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./svg_format.js"), require("./dotcode_layout.js"));
  } else {
    root.EReaderSvgRenderer = factory(root.EReaderSvgFormat, root.EReaderDotcodeLayout);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (format, layout) {
  "use strict";

  const {
    RAW_METADATA_ID,
    DOTCODE_BYTES_PER_BLOCK,
    DOTCODE_RENDER_DPI,
    DOTCODE_RENDER_SCALE,
    DOTCODE_GRID_DPI,
    DOTCODE_DATA_DOT_SIZE,
    DOTCODE_DATA_DOT_RADIUS,
    DOTCODE_SYNC_MARKER_DIAMETER,
  } = format.constants;
  const DOTCODE_MODULATION = layout.MODULATION_TABLE;
  const dotcodeDataPosition = layout.dataPosition;
  const svgNumber = (value) => {
    const rounded = Math.round(value * 10000) / 10000;
    return Object.is(rounded, -0) ? "0" : String(rounded);
  };

  function createSvgRenderer(patcher) {
    const { PatcherError, asBytes, inspectScanCard, crc32, bytesToHex } = patcher;
    function rawDotcodeToSvg(rawInput, label = "RAW input", options = {}) {
      const raw = asBytes(rawInput, "RAW input");
      const metadata = inspectScanCard(raw, label);
      const embeddedTitle =
        metadata.titleEncoding !== "none" && metadata.titleEncoding !== "generic card-type name"
          ? metadata.embeddedTitle
          : "";
      const dotcodePosition = `(${metadata.cardIndex}/${metadata.cardCount})`;
      const documentTitle = embeddedTitle
        ? `Nintendo e-Reader dot code: ${embeddedTitle} ${dotcodePosition}`
        : `Nintendo e-Reader dot code ${dotcodePosition}`;
      const escapedDocumentTitle = documentTitle
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      const blockCount = raw.length / DOTCODE_BYTES_PER_BLOCK;
      const logicalWidth = blockCount * 35 + 9;
      const logicalHeight = 44;
      const viewWidth = logicalWidth * DOTCODE_RENDER_SCALE;
      const viewHeight = logicalHeight * DOTCODE_RENDER_SCALE;
      const configuredDotSize =
        options && options.dotSize !== undefined ? Number(options.dotSize) : DOTCODE_DATA_DOT_SIZE;
      if (
        !Number.isFinite(configuredDotSize) ||
        configuredDotSize <= 0 ||
        configuredDotSize >= DOTCODE_RENDER_SCALE
      ) {
        throw new PatcherError(
          `dotSize must be greater than 0 and smaller than ${DOTCODE_RENDER_SCALE}`,
        );
      }
      const dotSize = Number(svgNumber(configuredDotSize));
      if (dotSize <= 0 || dotSize >= DOTCODE_RENDER_SCALE) {
        throw new PatcherError(
          "dotSize must remain greater than 0 and smaller than 7 after SVG rounding",
        );
      }
      const configuredDotRadius =
        options && options.dotRadius !== undefined
          ? Number(options.dotRadius)
          : DOTCODE_DATA_DOT_RADIUS;
      if (!Number.isFinite(configuredDotRadius) || configuredDotRadius < 0) {
        throw new PatcherError("dotRadius must be a finite number greater than or equal to 0");
      }
      const dotInset = (DOTCODE_RENDER_SCALE - dotSize) / 2;
      const dotCornerRadius = Number(svgNumber(Math.min(dotSize / 2, configuredDotRadius)));

      const widthPoints = ((viewWidth * 72) / DOTCODE_RENDER_DPI).toFixed(2);
      const heightPoints = ((viewHeight * 72) / DOTCODE_RENDER_DPI).toFixed(2);
      const dots = new Set();
      const addDot = (x, y) => dots.add(y * logicalWidth + x);

      const startAddress = raw[DOTCODE_BYTES_PER_BLOCK + 1];
      const addresses = layout.addressSequence(startAddress, blockCount + 1);
      for (let block = 0; block < blockCount; block += 1) {
        const leftX = block * 35 + 4;
        const rightX = (block + 1) * 35 + 4;
        addDot(leftX, 9);
        addDot(rightX, 9);
        for (let bit = 0; bit < 16; bit += 1) {
          if (addresses[block] & (1 << bit)) {
            addDot(leftX, 33 - bit);
          }
          if (addresses[block + 1] & (1 << bit)) {
            addDot(rightX, 33 - bit);
          }
        }

        for (let index = 0; index <= 5; index += 1) {
          for (const x of [block * 35 + 10 + index * 2, block * 35 + 23 + index * 2]) {
            addDot(x, 4);
            addDot(x, 39);
          }
        }

        let sampleIndex = 0;
        const blockOffset = block * DOTCODE_BYTES_PER_BLOCK;
        for (let byteIndex = 0; byteIndex < DOTCODE_BYTES_PER_BLOCK; byteIndex += 1) {
          const value = raw[blockOffset + byteIndex];
          for (let shift = 4; shift >= 0; shift -= 4) {
            const nibble = (value >>> shift) & 0x0f;
            const symbol = DOTCODE_MODULATION[nibble];
            for (let bit = 4; bit >= 0; bit -= 1) {
              if (symbol & (1 << bit)) {
                const [x, y] = dotcodeDataPosition(sampleIndex);
                addDot(block * 35 + x, y);
              }
              sampleIndex += 1;
            }
          }
        }
        if (sampleIndex !== 1040) {
          throw new Error("Generated dot-code block has an invalid modulation size");
        }
      }

      const markerRadius = DOTCODE_SYNC_MARKER_DIAMETER / 2;
      const svgParts = [
        '<g fill="#000000" stroke="none" stroke-width="0" shape-rendering="geometricPrecision">',
        "<g>",
      ];
      for (let marker = 0; marker <= blockCount; marker += 1) {
        const centerX = (marker * 35 + 4.5) * DOTCODE_RENDER_SCALE;
        for (const centerY of [4.5 * DOTCODE_RENDER_SCALE, 39.5 * DOTCODE_RENDER_SCALE]) {
          svgParts.push(
            `<circle cx="${svgNumber(centerX)}" cy="${svgNumber(centerY)}"` +
              ` r="${svgNumber(markerRadius)}"/>`,
          );
        }
      }

      svgParts.push("</g>");
      const radiusAttributes =
        dotCornerRadius === 0
          ? ""
          : ` rx="${svgNumber(dotCornerRadius)}" ry="${svgNumber(dotCornerRadius)}"`;
      const dotAttributes =
        ` width="${svgNumber(dotSize)}" height="${svgNumber(dotSize)}"` + radiusAttributes + "/>";
      const xPositions = Array.from({ length: logicalWidth }, (_, x) =>
        svgNumber(x * DOTCODE_RENDER_SCALE + dotInset),
      );
      const yPositions = Array.from({ length: logicalHeight }, (_, y) =>
        svgNumber(y * DOTCODE_RENDER_SCALE + dotInset),
      );
      const elementsPerGroup = 512;
      let dotIndex = 0;
      for (const coordinate of dots) {
        if (dotIndex % elementsPerGroup === 0) svgParts.push("<g>");
        const x = coordinate % logicalWidth;
        const y = Math.floor(coordinate / logicalWidth);
        svgParts.push(`<rect x="${xPositions[x]}" y="${yPositions[y]}"` + dotAttributes);
        dotIndex += 1;
        if (dotIndex % elementsPerGroup === 0) svgParts.push("</g>");
      }
      if (dotIndex % elementsPerGroup !== 0) svgParts.push("</g>");
      svgParts.push("</g>");

      return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${widthPoints}pt"` +
          ` height="${heightPoints}pt" viewBox="0 0 ${viewWidth} ${viewHeight}"` +
          ' shape-rendering="geometricPrecision" color-interpolation="sRGB"' +
          ` data-dpi="${DOTCODE_RENDER_DPI}"` +
          ` data-raster-dpi="${DOTCODE_RENDER_DPI}"` +
          ` data-grid-dpi="${DOTCODE_GRID_DPI.toFixed(6)}"` +
          ` data-grid-scale="${DOTCODE_RENDER_SCALE}"` +
          ` data-data-dot-size="${dotSize}"` +
          ' data-data-dot-shape="rounded-square"' +
          ` data-data-dot-radius="${svgNumber(dotCornerRadius)}"` +
          ' data-sync-marker-shape="circle"' +
          ` data-sync-marker-diameter="${svgNumber(DOTCODE_SYNC_MARKER_DIAMETER)}">`,
        `<title>${escapedDocumentTitle}</title>`,
        `<metadata id="${RAW_METADATA_ID}" data-encoding="hex"` +
          ` data-byte-length="${raw.length}"` +
          ` data-crc32="${crc32(raw).toString(16).toUpperCase().padStart(8, "0")}">` +
          `${bytesToHex(raw)}</metadata>`,
        `<desc>Original-size, binary black-and-white dot code. Rasterize at ` +
          `${DOTCODE_RENDER_DPI} ppi without resampling.</desc>`,
        `<rect width="${viewWidth}" height="${viewHeight}" fill="#ffffff"` +
          ' stroke="none" stroke-width="0" shape-rendering="crispEdges"/>',
        ...svgParts,
        "</svg>",
        "",
      ].join("\n");
    }
    return rawDotcodeToSvg;
  }

  return Object.freeze({ createSvgRenderer });
});
