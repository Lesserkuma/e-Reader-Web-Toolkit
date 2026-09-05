"use strict";

importScripts(...[
  "processing_limits.js",
  "binary.js",
  "reed_solomon.js",
  "dotcode_layout.js",
  "raw_codec.js",
  "dotcode_math.js",
  "dotcode_sampling.js",
  "dotcode_recovery.js",
  "dotcode_scan.js",
].map(source => source + self.location.search));

self.onmessage = ({ data: pixels }) => {
  try {
    const qualities = [];
    const strips = self.EReaderDotcodeScan.decodeDotcodeImages(pixels, {
      onStripDecoded: (_raw, quality) => qualities.push(quality),
    });
    self.postMessage({ strips, qualities }, strips.map(raw => raw.buffer));
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
