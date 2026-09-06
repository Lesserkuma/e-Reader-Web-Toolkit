(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EReaderAppImport = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createImportController({
    model,
    view,
    patcher,
    dotcode,
    zipArchive,
    fileServices,
    svgServices,
    browserRuntime,
    saveData,
    nextFrame,
  }) {
    const {
      state,
      selectedDotcodeFiles,
      refreshDuplicateDotcodes,
      analyzePreparedDotcodes,
    } = model;
    const {
      fileKind,
      fileSizeError,
      readFileBytes,
      rememberDecodedDotcodes,
      scanImageDimensionsForFile,
    } = fileServices;
    const { loadSvgImagePixels, readSvgInput } = svgServices;
    const { loadImagePixels } = browserRuntime;
    const { setStatus, renderInputs, refreshInputStatus } = view;

    const ARCHIVE_ENTRY_EXTENSIONS = Object.freeze([
      ".gba",
      ".sav",
      ".raw",
      ".jpg",
      ".jpeg",
      ".png",
      ".svg",
    ]);

    const ARCHIVE_ENTRY_MIME_TYPES = Object.freeze({
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    });

    function appendNotice(message) {
      state.inputNotice = [state.inputNotice, message].filter(Boolean).join(" ");
    }

    function rejectContentFile(file, message) {
      state.sourceFiles = state.sourceFiles.filter((candidate) => candidate !== file);
      state.preparedDotcodes.delete(file);
      state.preparedSaves.delete(file);
      appendNotice(`Ignored invalid content input: ${file.name}: ${message}`);
    }

    async function expandZipInputs(requestedFiles) {
      const files = [];
      const notices = [];
      for (const file of requestedFiles) {
        if (fileKind(file) !== "ZIP") {
          files.push(file);
          continue;
        }
        if (file.size > zipArchive.MAX_ARCHIVE_SIZE) {
          notices.push(`Ignored ZIP archive ${file.name}: the archive exceeds the 64 MiB limit.`);
          continue;
        }
        try {
          setStatus(`Reading ZIP archive: ${file.name}…`);
          await nextFrame();
          const bytes = await readFileBytes(file);
          const extracted = await zipArchive.extractSupportedFiles(bytes, ARCHIVE_ENTRY_EXTENSIONS);
          if (extracted.files.length === 0) {
            notices.push(`Ignored ZIP archive ${file.name}: it contains no supported input files.`);
            continue;
          }
          for (const entry of extracted.files) {
            const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
            files.push(
              new File([entry.bytes], entry.name, {
                type: ARCHIVE_ENTRY_MIME_TYPES[extension] || "application/octet-stream",
                lastModified: file.lastModified,
              }),
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notices.push(`Ignored ZIP archive ${file.name}: ${message}`);
        }
      }
      return { files, notices };
    }

    async function processFileBatch(requestedFiles) {
      state.inputNotice = "";
      const expansion = await expandZipInputs(requestedFiles);
      const notices = [...expansion.notices];
      setStatus("Checking added files for duplicates…");
      await nextFrame();
      const duplicateCheck = await fileServices.filterDuplicateFiles(expansion.files, state);
      const files = duplicateCheck.accepted;
      for (const rejection of duplicateCheck.rejected || []) {
        notices.push(`Ignored unreadable input: ${rejection.message}`);
      }
      if (duplicateCheck.ignored.length > 0) {
        notices.push(
          `Ignored duplicate file${duplicateCheck.ignored.length === 1 ? "" : "s"}: ` +
            duplicateCheck.ignored.map((file) => file.name).join(", "),
        );
      }
      const unknown = files.filter((file) => !fileKind(file));
      if (unknown.length > 0) {
        notices.push(
          `Ignored unsupported file${unknown.length === 1 ? "" : "s"}: ` +
            unknown.map((file) => file.name).join(", "),
        );
      }
      const romFiles = files.filter((file) => fileKind(file) === "ROM");
      if (romFiles.length > 1) {
        notices.push("Add only one base ROM at a time.");
      } else if (romFiles.length === 1) {
        const file = romFiles[0];
        const sizeError = fileSizeError(file);
        const previousRom = state.preparedRom;
        if (sizeError) {
          if (previousRom) {
            notices.push(`Ignored invalid base ROM input: ${sizeError}`);
          } else {
            state.romFile = file;
            state.preparedRom = null;
            state.romError = sizeError;
          }
        } else {
          try {
            setStatus(`Reading and validating base ROM: ${file.name}…`);
            await nextFrame();
            const bytes = await readFileBytes(file);
            const profile = await patcher.validateRom(bytes);
            state.romFile = file;
            state.preparedRom = { file, bytes, profile };
            state.additionalScanError = "";
            state.romError = "";
            state.compatibilityError = "";
            state.optionError = "";
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (previousRom) {
              notices.push(`Ignored invalid base ROM input: ${message}`);
            } else {
              state.romFile = file;
              state.preparedRom = null;
              state.romError = message;
            }
          }
        }
      }

      state.inputNotice = notices.join(" ");
      for (const file of files.filter((file) =>
        ["SAV", "RAW", "SCAN", "SVG"].includes(fileKind(file)),
      )) {
        const sizeError = fileSizeError(file);
        if (sizeError) {
          appendNotice(`Ignored invalid content input: ${file.name}: ${sizeError}`);
          continue;
        }
        if (!state.sourceFiles.includes(file)) state.sourceFiles.push(file);
        model.resetContentErrors();
        if (fileKind(file) === "SAV") await prepareSaveFile(file);
        else await prepareDotcodeFiles([file]);
      }
      refreshDuplicateDotcodes();
      analyzePreparedDotcodes();
      renderInputs();
      refreshInputStatus();
    }

    async function prepareSaveFile(file) {
      if (!file || fileKind(file) !== "SAV" || !state.sourceFiles.includes(file)) {
        return;
      }
      state.sourceError = "";
      state.sourceNotice = "";
      state.preparedSaves.delete(file);
      renderInputs();

      try {
        setStatus(`Reading and validating save data: ${file.name}…`);
        await nextFrame();
        const bytes = await readFileBytes(file);
        const inspected = saveData.inspect(bytes, file.name);
        state.preparedSaves.set(file, {
          file,
          bytes,
          application: inspected.application,
          calibration: inspected.calibration,
        });
        if (inspected.application?.rawEntries.length) {
          state.preparedDotcodes.set(file, inspected.application.rawEntries);
          rememberDecodedDotcodes(file, inspected.application.rawEntries);
        }
        analyzePreparedDotcodes();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rejectContentFile(file, message);
        analyzePreparedDotcodes();
      }
    }

    async function prepareDotcodeFiles(incomingFiles = selectedDotcodeFiles()) {
      incomingFiles = incomingFiles.filter((file) =>
        ["RAW", "SCAN", "SVG"].includes(fileKind(file)),
      );
      if (incomingFiles.length === 0) return;
      state.sourceError = "";
      state.sourceNotice = "";
      state.preparedApplication = null;
      state.preparedNative = null;
      renderInputs();
      for (let index = 0; index < incomingFiles.length; index += 1) {
        const file = incomingFiles[index];
        try {
          const fileEntries = await readDotcodeFile(file);
          rememberDecodedDotcodes(file, fileEntries);
          state.preparedDotcodes.set(file, fileEntries);
        } catch (error) {
          rejectContentFile(file, error instanceof Error ? error.message : String(error));
        }
        renderInputs();
      }
      refreshDuplicateDotcodes();
      analyzePreparedDotcodes();
    }

    async function readDotcodeFile(file) {
      const sourceKind = fileKind(file);
      setStatus(`Reading dot-code content: ${file.name}…`);
      await nextFrame();
      let decodedStrips;
      const preparedBaseName = file.name.replace(/\.(?:raw|svg|jpe?g|png)$/i, "");
      const scanQualities = new Map();
      const decodePixels = (pixels) =>
        browserRuntime.decodeDotcodeImages(pixels, dotcode, {
          onStripDecoded: (raw, quality) => scanQualities.set(raw, quality),
        });
      if (sourceKind === "SVG") {
        const svgInput = await readSvgInput(file);
        if (svgInput.rawMetadata) {
          decodedStrips = [svgInput.rawMetadata];
        } else {
          setStatus(`Rasterizing SVG dot-code image: ${file.name}…`);
          await nextFrame();
          decodedStrips = await decodePixels(await loadSvgImagePixels(file, svgInput));
        }
      } else if (sourceKind === "SCAN") {
        decodedStrips = await decodePixels(await loadImagePixels(file, scanImageDimensionsForFile));
      } else {
        decodedStrips = [await readFileBytes(file)];
      }
      return decodedStrips.map((bytes, index) => {
        const single = decodedStrips.length === 1;
        const label = single ? file.name : `${file.name} (dot code ${index + 1}/${decodedStrips.length})`;
        return {
          name: single ? `${preparedBaseName}.raw` : `${preparedBaseName} [dot code ${index + 1}].raw`,
          sourceName: file.name,
          bytes,
          metadata: patcher.inspectScanCard(bytes, label),
          scanQuality: scanQualities.get(bytes) || null,
        };
      });
    }

    function enqueueFiles(fileList) {
      if (state.busy) {
        return;
      }
      const files = Array.from(fileList || []);
      if (files.length === 0) {
        return;
      }
      state.pendingFileBatches.push(files);
      if (state.drainingFileBatches) {
        const queuedCount = state.pendingFileBatches.reduce(
          (total, batch) => total + batch.length,
          0,
        );
        state.inputNotice =
          `${queuedCount} file${queuedCount === 1 ? "" : "s"} queued ` +
          "until the current import finishes.";
        renderInputs();
        setStatus(state.inputNotice, "warning");
      }
      void drainPendingFileBatches();
    }

    async function drainPendingFileBatches() {
      if (state.drainingFileBatches) {
        return;
      }
      state.drainingFileBatches = true;
      try {
        while (state.pendingFileBatches.length > 0) {
          const batch = state.pendingFileBatches.shift();
          let importFailure = "";
          state.preparing = true;
          renderInputs();
          try {
            await processFileBatch(batch);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            importFailure = `Ignored unreadable input: ${message}`;
            state.inputNotice = importFailure;
          } finally {
            state.preparing = false;
            renderInputs();
            refreshInputStatus();
            if (importFailure) {
              setStatus(importFailure, "warning");
            }
          }
        }
      } finally {
        state.preparing = false;
        state.drainingFileBatches = false;
      }
    }
    return Object.freeze({
      enqueueFiles,
      processFileBatch,
    });
  }

  return Object.freeze({ createImportController });
});
