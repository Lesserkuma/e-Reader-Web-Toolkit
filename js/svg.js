(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./svg_format.js"),
      require("./svg_renderer.js"),
      require("./svg_raster.js"),
    );
  } else {
    root.EReaderSvg = factory(
      root.EReaderSvgFormat,
      root.EReaderSvgRenderer,
      root.EReaderSvgRaster,
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (format, renderer, raster) {
  "use strict";

  const { constants, isSvgFile, decodeSvgText } = format;

  function createSvgServices(patcher, { readFileBytes } = {}) {
    if (
      !patcher ||
      typeof patcher.asBytes !== "function" ||
      typeof patcher.inspectScanCard !== "function" ||
      typeof patcher.crc32 !== "function" ||
      typeof patcher.bytesToHex !== "function" ||
      typeof patcher.PatcherError !== "function" ||
      !patcher.constants ||
      !Number.isInteger(patcher.constants.RAW_LONG_SIZE) ||
      !Number.isInteger(patcher.constants.RAW_SHORT_SIZE)
    ) {
      throw new TypeError("A complete e-Reader patcher API is required");
    }
    if (readFileBytes !== undefined && typeof readFileBytes !== "function") {
      throw new TypeError("SVG byte reader must be a function");
    }

    const { asBytes } = patcher;
    const extractSvgRawMetadata = format.createMetadataReader(patcher);
    const rawDotcodeToSvg = renderer.createSvgRenderer(patcher);
    const loadSvgImagePixels = raster.createSvgRasterizer(readSvgFileBytes);

    function prepareSvgInput(bytesInput, label = "SVG input") {
      const bytes = asBytes(bytesInput, "SVG input");
      const source = decodeSvgText(bytes, label);
      return Object.freeze({
        bytes,
        source,
        rawMetadata: extractSvgRawMetadata(source, label),
      });
    }

    async function readSvgFileBytes(file) {
      if (readFileBytes) {
        return asBytes(await readFileBytes(file), file.name);
      }
      try {
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${file.name} could not be read: ${message}`);
      }
    }

    async function readSvgInput(file) {
      if (!isSvgFile(file)) {
        throw new TypeError("SVG input can only be read from an .svg file");
      }
      const bytes = await readSvgFileBytes(file);
      return prepareSvgInput(bytes, file.name);
    }
    return Object.freeze({
      rawDotcodeToSvg,
      isSvgFile,
      decodeSvgText,
      prepareSvgInput,
      extractSvgRawMetadata,
      readSvgInput,
      loadSvgImagePixels,
    });
  }

  return Object.freeze({ constants, createSvgServices });
});
