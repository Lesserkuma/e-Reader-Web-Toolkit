(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EReaderAppModel = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createAppModel(patcher, fileServices) {
    const { fileKind, createDotcodeIndex } = fileServices;

    const state = {
      romFile: null,
      preparedRom: null,
      sourceFiles: [],
      romError: "",
      compatibilityError: "",
      optionError: "",
      sourceError: "",
      sourceNotice: "",
      inputNotice: "",
      preparing: false,
      preparedDotcodes: new Map(),
      preparedApplication: null,
      preparedNative: null,
      preparedSave: null,
      pendingFileBatches: [],
      drainingFileBatches: false,
      busy: false,
      outputMode: "rom",
      applicationTitle: "",
    };

    function isSaveDataMode() {
      return state.outputMode === "save";
    }

    function regionLabel(region) {
      return region === 1 || region === "usa" ? "English" : "Japanese";
    }

    function queuedContentFiles() {
      return state.pendingFileBatches
        .flatMap((batch) => batch)
        .filter((file) => ["SAV", "RAW", "SCAN", "SVG"].includes(fileKind(file)));
    }

    function selectedSaveFiles() {
      return state.sourceFiles.filter((file) => fileKind(file) === "SAV");
    }

    function selectedDotcodeFiles() {
      return state.sourceFiles.filter((file) => ["RAW", "SCAN", "SVG"].includes(fileKind(file)));
    }

    function selectedApplicationIsReady() {
      const dotcodeFiles = selectedDotcodeFiles();
      if (dotcodeFiles.length > 0) {
        return Boolean(state.preparedApplication || state.preparedNative);
      }
      const saveFiles = selectedSaveFiles();
      return Boolean(
        saveFiles.length === 1 &&
          state.preparedSave?.file === saveFiles[0] &&
          state.preparedSave.application,
      );
    }

    function resetContentErrors() {
      state.compatibilityError = "";
      state.optionError = "";
      state.sourceError = "";
      state.sourceNotice = "";
    }

    function removeSaveFile(file) {
      if (state.busy || state.preparing || fileKind(file) !== "SAV") {
        return;
      }
      state.sourceFiles = state.sourceFiles.filter((candidate) => candidate !== file);
      if (state.preparedSave?.file === file) {
        state.preparedSave = null;
      }
      resetContentErrors();
      state.inputNotice = "";
      analyzePreparedDotcodes();
      return true;
    }

    function removeSaveComponent(file, component) {
      if (
        state.busy ||
        state.preparing ||
        state.preparedSave?.file !== file ||
        !["application", "calibration"].includes(component)
      ) {
        return;
      }

      resetContentErrors();
      state.preparedSave[component] = null;

      if (!state.preparedSave.application && !state.preparedSave.calibration) {
        return removeSaveFile(file);
      }

      state.inputNotice = "";
      analyzePreparedDotcodes();
      return true;
    }

    function removePreparedDotcode(file, entry) {
      if (state.busy || state.preparing) {
        return;
      }
      const entries = state.preparedDotcodes.get(file);
      const entryIndex = entries?.indexOf(entry) ?? -1;
      if (entryIndex < 0) {
        return;
      }

      resetContentErrors();
      state.preparedApplication = null;
      state.preparedNative = null;

      const retainedEntries = entries.filter((_candidate, index) => index !== entryIndex);
      if (retainedEntries.length > 0) {
        state.preparedDotcodes.set(file, retainedEntries);
      } else {
        state.preparedDotcodes.delete(file);
        state.sourceFiles = state.sourceFiles.filter((candidate) => candidate !== file);
      }

      state.inputNotice = "";
      analyzePreparedDotcodes();
      return true;
    }

    function clearKind(kind) {
      if (state.busy || state.preparing) {
        return;
      }
      if (kind === "rom" || kind === "all") {
        state.romFile = null;
        state.preparedRom = null;
        state.romError = "";
        state.compatibilityError = "";
        state.optionError = "";
      }
      if (kind === "source" || kind === "all") {
        state.sourceFiles = [];
        state.compatibilityError = "";
        state.optionError = "";
        state.sourceError = "";
        state.sourceNotice = "";
        state.preparedDotcodes = new Map();
        state.preparedApplication = null;
        state.preparedNative = null;
        state.preparedSave = null;
        state.applicationTitle = "";
      }
      state.inputNotice = "";
      return true;
    }

    function contentItems() {
      const items = [];
      const usingDotcodeContent = selectedDotcodeFiles().length > 0;
      const pendingDetails = () => ({
        state: "pending",
        region: "Reading\u2026",
        title: "\u2014",
        index: "\u2014",
        count: "\u2014",
      });

      for (const file of state.sourceFiles) {
        if (fileKind(file) === "SAV") {
          const preparedSave = state.preparedSave?.file === file ? state.preparedSave : null;
          if (!preparedSave) {
            items.push({
              file,
              entry: null,
              contentKind: "application",
              details: pendingDetails(),
              removeAction: "save-file",
            });
            continue;
          }
          if (preparedSave.application) {
            const { metadata, rawEntries } = preparedSave.application;
            if (!usingDotcodeContent) {
              if (rawEntries.length > 0) {
                for (const [index, entry] of rawEntries.entries()) {
                  items.push({
                    file,
                    entry,
                    contentKind: "application",
                    details: {
                      state: "ready",
                      region: regionLabel(metadata.applicationRegion),
                      title: metadata.title || "Untitled",
                      index: String(entry.metadata.cardIndex),
                      count: String(entry.metadata.cardCount),
                    },
                    removeAction: index === 0 ? "save-application" : null,
                  });
                }
              } else {
                items.push({
                  file,
                  entry: null,
                  contentKind: "application",
                  details: {
                    state: "ready",
                    region: regionLabel(metadata.applicationRegion),
                    title: metadata.title || "Untitled",
                    index: "\u2014",
                    count: "\u2014",
                  },
                  removeAction: "save-application",
                });
              }
            } else {
              items.push({
                file,
                entry: null,
                contentKind: "inactive-save-application",
                details: {
                  state: "inactive",
                  region: "Inactive",
                  title: `Saved card content (inactive): ${metadata.title || "Untitled"}`,
                  index: "\u2014",
                  count: "\u2014",
                },
                removeAction: "save-application",
              });
            }
          }
          if (isSaveDataMode() && preparedSave.calibration) {
            items.push({
              file,
              entry: null,
              contentKind: "calibration",
              details: {
                state: "ready",
                region: "\u2014",
                title: "e-Reader Calibration Data",
                index: "\u2014",
                count: "\u2014",
              },
              removeAction: "save-calibration",
            });
          }
          continue;
        }
        const entries = state.preparedDotcodes.get(file);
        if (entries && entries.length > 0) {
          for (const entry of entries) {
            items.push({
              file,
              entry,
              contentKind: "application",
              details: {
                state: "ready",
                region: regionLabel(entry.metadata.region),
                title: entry.metadata.embeddedTitle || "Untitled",
                index: String(entry.metadata.cardIndex),
                count: String(entry.metadata.cardCount),
              },
              removeAction: "dotcode",
            });
          }
        } else {
          items.push({
            file,
            entry: null,
            contentKind: "application",
            details: pendingDetails(),
            removeAction: null,
          });
        }
      }
      for (const file of queuedContentFiles()) {
        items.push({
          file,
          entry: null,
          contentKind: "application",
          details: pendingDetails(),
          removeAction: null,
        });
      }

      for (const item of items) {
        item.details.crc32 = item.entry
          ? patcher.crc32(item.entry.bytes).toString(16).toUpperCase().padStart(8, "0")
          : "\u2014";
      }
      return items;
    }

    function refreshDuplicateDotcodes() {
      const uniqueEntries = createDotcodeIndex();
      const retainedFiles = [];
      let duplicateCount = 0;
      for (const file of state.sourceFiles) {
        const entries = state.preparedDotcodes.get(file);
        if (!entries) {
          retainedFiles.push(file);
          continue;
        }
        const retainedEntries = [];
        for (const entry of entries) {
          if (uniqueEntries.has(entry)) {
            duplicateCount += 1;
          } else {
            uniqueEntries.add(entry);
            retainedEntries.push(entry);
          }
        }
        if (retainedEntries.length > 0) {
          state.preparedDotcodes.set(file, retainedEntries);
          retainedFiles.push(file);
        } else {
          state.preparedDotcodes.delete(file);
        }
      }
      state.sourceFiles = retainedFiles;
      if (duplicateCount > 0) {
        const duplicateNotice = `Ignored ${duplicateCount} duplicate dot-code ${duplicateCount === 1 ? "entry" : "entries"}.`;
        state.inputNotice = [state.inputNotice, duplicateNotice].filter(Boolean).join(" ");
      }
    }

    function analyzePreparedDotcodes() {
      state.sourceError = "";
      state.sourceNotice = "";
      state.preparedApplication = null;
      state.preparedNative = null;
      const saveFiles = selectedSaveFiles();
      const dotcodeFiles = selectedDotcodeFiles();
      if (dotcodeFiles.length === 0 && saveFiles.length > 0) {
        if (state.preparedSave?.file !== saveFiles[0]) {
          state.sourceError = "The save file has not finished validating.";
        }
        return;
      }
      if (dotcodeFiles.length === 0) {
        return;
      }
      const allFilesPrepared = dotcodeFiles.every((file) => {
        const entries = state.preparedDotcodes.get(file);
        return entries && entries.length > 0;
      });
      const allEntries = dotcodeFiles.flatMap((file) => state.preparedDotcodes.get(file) || []);
      if (!allFilesPrepared || allEntries.length === 0) {
        return;
      }
      const entries = allEntries;

      const contentKinds = new Set(
        entries.map((entry) => entry.metadata.contentKind || "application"),
      );
      if (contentKinds.size !== 1) {
        state.sourceError =
          "Different content types cannot be combined. Please remove all but one.";
        return;
      }
      if (!contentKinds.has("application")) {
        if (entries.length !== 1) {
          state.sourceError =
            "Only one item of this content type can be used at a time. Please remove all but one.";
          return;
        }
        state.preparedNative = entries[0];
        return;
      }
      const setIds = new Set(entries.map((entry) => entry.metadata.setId));
      if (setIds.size !== 1) {
        state.sourceError =
          "The selected files contain different content sets. Please remove all but one set.";
        return;
      }

      const cardCount = entries[0].metadata.cardCount;
      const indices = new Set();
      for (const entry of entries) {
        const cardIndex = entry.metadata.cardIndex;
        if (indices.has(cardIndex)) {
          state.sourceError = `Duplicate internal dot-code strip index ${cardIndex}.`;
          return;
        }
        indices.add(cardIndex);
      }

      const missing = [];
      for (let index = 1; index <= cardCount; index += 1) {
        if (!indices.has(index)) {
          missing.push(index);
        }
      }
      if (missing.length > 0 || indices.size !== cardCount) {
        state.sourceNotice =
          `Dot-code set incomplete: ${indices.size} of ${cardCount} strips added; ` +
          `missing internal strip${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. ` +
          "Add the remaining file(s) using the same drop zone.";
        return;
      }

      const fallbackTitle = entries.some((entry) => entry.metadata.embeddedTitle) ? "" : "Untitled";

      try {
        state.preparedApplication = patcher.rawFilesToApplication(
          entries.map((entry) => ({ name: entry.name, bytes: entry.bytes })),
          fallbackTitle,
        );
      } catch (error) {
        state.sourceError = error instanceof Error ? error.message : String(error);
      }
    }
    return Object.freeze({
      state,
      resetContentErrors,
      contentItems,
      isSaveDataMode,
      queuedContentFiles,
      selectedSaveFiles,
      selectedDotcodeFiles,
      selectedApplicationIsReady,
      removeSaveFile,
      removeSaveComponent,
      removePreparedDotcode,
      clearKind,
      refreshDuplicateDotcodes,
      analyzePreparedDotcodes,
    });
  }

  return Object.freeze({ createAppModel });
});
