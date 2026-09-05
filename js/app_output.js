(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EReaderAppOutput = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createOutputController({
    model,
    view,
    elements,
    patcher,
    saveData,
    fileServices,
    browserRuntime,
    svgServices,
    nextFrame,
  }) {
    const { state, selectedSaveFiles, selectedDotcodeFiles, isSaveDataMode } = model;
    const { setStatus, renderInputs } = view;
    const { safeFilename } = fileServices;
    const { downloadBytes } = browserRuntime;
    const { rawDotcodeToSvg } = svgServices;

    function loadSource() {
      const saveFiles = selectedSaveFiles();
      const dotcodeFiles = selectedDotcodeFiles();
      if (dotcodeFiles.length > 0) {
        if (state.preparedNative) {
          return {
            nativeRaw: state.preparedNative.bytes,
            metadata: state.preparedNative.metadata,
          };
        }

        const application = state.preparedApplication;
        if (!application) {
          throw new Error("The dot-code content set has not finished validating.");
        }
        const save = patcher.buildVirtualSave(application);
        const metadata = patcher.validateSave(save);
        return {
          save,
          metadata: {
            ...metadata,
            applicationRegion: application.region === 1 ? "usa" : "japan",
            scanRegion: application.region,
          },
        };
      }

      if (saveFiles.length === 1) {
        if (state.preparedSave?.file !== saveFiles[0]) {
          throw new Error("The save file has not finished validating.");
        }
        if (!state.preparedSave.application) {
          throw new Error(
            "The selected SAV contains calibration data but no saved application. " +
              "Add RAW strips or dot-code images to continue.",
          );
        }
        return {
          save: state.preparedSave.bytes,
          metadata: state.preparedSave.application.metadata,
        };
      }

      throw new Error("No application content has finished validating.");
    }

    function markBuildError(error) {
      const message = error instanceof Error ? error.message : String(error);
      state.compatibilityError = "";
      state.optionError = "";
      if (/application title|title is too long|title must/i.test(message)) {
        state.optionError = message;
      } else if (/requires the .*base ROM/i.test(message)) {
        state.compatibilityError = message;
      } else if (/\bROM\b|base ROM|ROM header|ROM space/i.test(message)) {
        state.romError = message;
      } else if (
        /save|application|title|RAW|VPK|CRC|payload|program|strip|scan|image|JPEG|PNG|SVG|dot-code|marker|Reed-Solomon/i.test(
          message,
        )
      ) {
        state.sourceError = message;
      }
      renderInputs();
      setStatus(`Error: ${message}`, "error");
      elements.status.focus({ preventScroll: true });
    }

    async function build() {
      if (state.busy || elements.buildButton.disabled) {
        return;
      }

      state.busy = true;
      state.romError = "";
      state.compatibilityError = "";
      state.optionError = "";
      state.sourceError = "";
      elements.buttonIdle.hidden = true;
      elements.buttonWorking.hidden = false;
      renderInputs();
      setStatus("Reading content data…");
      await nextFrame();

      try {
        const source = loadSource();
        if (isSaveDataMode()) {
          if (source.nativeRaw) {
            throw new Error(
              "This card type cannot be stored as an e-Reader saved application. Use ROM output instead.",
            );
          }
          setStatus("Generating e-Reader save data…");
          await nextFrame();
          const configuredTitle = state.applicationTitle;
          const hasConfiguredTitle = configuredTitle.trim().length > 0;
          const save = saveData.build({
            sourceSave: source.save,
            applicationMetadata: source.metadata,
            fallbackRegion: state.preparedRom?.profile?.key || null,
            calibration: state.preparedSave?.calibration || null,
            title: hasConfiguredTitle ? configuredTitle : "",
          });
          const title = hasConfiguredTitle ? configuredTitle : source.metadata.title;
          const baseName = safeFilename(title, "e-Reader application");
          const saveFilename = `${baseName}.sav`;
          downloadBytes(save, saveFilename, "application/octet-stream");
          setStatus(`Download started: ${saveFilename}`, "success");
          return;
        }
        setStatus("Validating the base ROM and applying checked patches…");
        await nextFrame();

        if (!state.preparedRom || state.preparedRom.file !== state.romFile) {
          throw new Error("The base ROM has not finished validating.");
        }
        const romBytes = state.preparedRom.bytes;
        const built = source.nativeRaw
          ? await patcher.buildNativeDotcodeRom(
              romBytes,
              source.nativeRaw,
              state.preparedNative.name,
            )
          : await patcher.buildPatchedRom(romBytes, source.save, source.metadata.applicationRegion);
        const metadata = { ...source.metadata, ...built.metadata };
        const baseName = safeFilename(metadata.title, "e-Reader application");
        const romFilename = `${baseName}.gba`;
        downloadBytes(built.rom, romFilename, "application/octet-stream");
        setStatus(`Download started: ${romFilename}`, "success");
      } catch (error) {
        markBuildError(error);
      } finally {
        state.busy = false;
        elements.buttonIdle.hidden = false;
        elements.buttonWorking.hidden = true;
        renderInputs();
      }
    }

    function downloadDotcode(entry, extension, filename) {
      try {
        if (extension === "raw") downloadBytes(entry.bytes, filename, "application/octet-stream");
        else
          downloadBytes(
            rawDotcodeToSvg(entry.bytes, entry.sourceName),
            filename,
            "image/svg+xml;charset=utf-8",
          );
      } catch (error) {
        setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    return Object.freeze({ build, downloadDotcode });
  }

  return Object.freeze({ createOutputController });
});
