(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.EReaderProcessingLimits = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  return Object.freeze({
    MAX_IMAGE_PIXELS: 60_000_000,
    MAX_IMAGE_DIMENSION: 32_767,
    MAX_IMAGE_FILE_BYTES: 64 * 1024 * 1024,
  });
});
