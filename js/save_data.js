(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.EReaderSaveData = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createSaveDataServices(patcher) {
    if (
      !patcher
      || typeof patcher.validateSave !== "function"
      || typeof patcher.extractSaveCalibration !== "function"
      || typeof patcher.applySaveCalibration !== "function"
      || typeof patcher.saveToRawDotcodes !== "function"
      || typeof patcher.inspectRawDotcode !== "function"
      || typeof patcher.setSaveApplicationTitle !== "function"
      || typeof patcher.asBytes !== "function"
      || !patcher.constants
    ) {
      throw new TypeError("A complete e-Reader patcher API is required");
    }

    function inspect(bytes, sourceName = "SAV input") {
      const sourceLabel = typeof sourceName === "string" && sourceName.trim()
        ? sourceName
        : "SAV input";
      let metadata = null;
      let applicationError = null;
      try {
        metadata = patcher.validateSave(bytes);
      } catch (error) {
        applicationError = error;
      }

      let calibration = null;
      let calibrationError = null;
      try {
        calibration = patcher.extractSaveCalibration(bytes);
      } catch (error) {
        calibrationError = error;
      }

      if (!metadata && !calibration) {
        const applicationMessage = applicationError instanceof Error
          ? applicationError.message
          : String(applicationError);
        const calibrationMessage = calibrationError instanceof Error
          ? calibrationError.message
          : String(calibrationError);
        throw new Error(
          "This SAV contains neither a valid saved application nor valid e-Reader "
          + `calibration data. Application: ${applicationMessage} `
          + `Calibration: ${calibrationMessage}`,
        );
      }

      const rawEntries = [];
      if (metadata) {
        try {
          const reconstructed = patcher.saveToRawDotcodes(bytes);
          for (let index = 0; index < reconstructed.length; index += 1) {
            const raw = reconstructed[index];
            const name = `${sourceLabel} (reconstructed dot code ${index + 1}).raw`;
            rawEntries.push({
              name,
              sourceName: sourceLabel,
              bytes: raw,
              metadata: patcher.inspectRawDotcode(raw, name),
            });
          }
        } catch {
          rawEntries.length = 0;
        }
      }

      return {
        application: metadata ? { metadata, rawEntries } : null,
        calibration,
      };
    }

    function build({
      sourceSave,
      applicationMetadata = null,
      fallbackRegion = null,
      calibration = null,
      title = "",
    } = {}) {
      const savedMetadata = patcher.validateSave(sourceSave);
      if (
        applicationMetadata !== null
        && (typeof applicationMetadata !== "object" || Array.isArray(applicationMetadata))
      ) {
        throw new TypeError("Application metadata must be an object");
      }
      if (fallbackRegion !== null && !["usa", "japan"].includes(fallbackRegion)) {
        throw new TypeError("Fallback region must be \"usa\", \"japan\", or null");
      }
      if (typeof title !== "string") {
        throw new TypeError("Application title must be a string");
      }

      const metadata = applicationMetadata || savedMetadata;
      let applicationRegion = metadata.applicationRegion || savedMetadata.applicationRegion;
      if ([0, 1, 2].includes(metadata.scanRegion)) {
        applicationRegion = metadata.scanRegion === 1 ? "usa" : "japan";
      } else if (
        (metadata.storedRegionCode ?? savedMetadata.storedRegionCode) === 2
        || /^Shift-JIS/.test(metadata.titleEncoding || savedMetadata.titleEncoding || "")
      ) {
        applicationRegion = "japan";
      } else if (
        (metadata.titleEncoding || savedMetadata.titleEncoding) === "e-Reader USA 1-byte"
      ) {
        applicationRegion = "usa";
      } else if (fallbackRegion) {
        applicationRegion = fallbackRegion;
      }
      if (!["usa", "japan"].includes(applicationRegion)) {
        throw new TypeError("Application region could not be determined");
      }

      let output;
      if (calibration === null) {
        output = Uint8Array.from(patcher.asBytes(sourceSave, "source save"));
        const size = patcher.constants.CALIBRATION_SECTOR_SIZE;
        const primary = patcher.constants.CALIBRATION_PRIMARY_OFFSET;
        const secondary = patcher.constants.CALIBRATION_SECONDARY_OFFSET;
        output.fill(0xff, primary, primary + size);
        output.fill(0xff, secondary, secondary + size);
      } else {
        output = patcher.applySaveCalibration(sourceSave, calibration);
      }

      if (title.trim()) {
        output = patcher.setSaveApplicationTitle(output, title, applicationRegion);
      }
      return output;
    }

    return Object.freeze({ inspect, build });
  }

  return Object.freeze({ createSaveDataServices });
});
