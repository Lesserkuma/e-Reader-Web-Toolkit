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
      preparedSaves: new Map(),
      preparedDotcodes: new Map(),
      contentOrder: [],
      mainCards: [],
      mainSave: null,
      preparedApplication: null,
      preparedNative: null,
      romError: "",
      compatibilityError: "",
      optionError: "",
      sourceError: "",
      sourceNotice: "",
      inputNotice: "",
      additionalScanError: "",
      preparing: false,
      pendingFileBatches: [],
      drainingFileBatches: false,
      busy: false,
      outputMode: "rom",
      applicationTitle: "",
      emulateAdditionalScans: false,
    };

    function isSaveDataMode() {
      return state.outputMode === "save";
    }

    function regionLabel(region) {
      if (region === 1 || region === "usa") return "English";
      if ([0, 2, "japan"].includes(region)) return "Japanese";
      return `Unknown (${region})`;
    }

    function queuedContentFiles() {
      return state.pendingFileBatches.flat().filter((file) =>
        ["SAV", "RAW", "SCAN", "SVG"].includes(fileKind(file)),
      );
    }

    function selectedSaveFiles() {
      return state.sourceFiles.filter((file) => fileKind(file) === "SAV");
    }

    function selectedDotcodeFiles() {
      return state.sourceFiles.filter((file) => ["RAW", "SCAN", "SVG"].includes(fileKind(file)));
    }

    function selectedCalibration() {
      for (const file of selectedSaveFiles()) {
        const calibration = state.preparedSaves.get(file)?.calibration;
        if (calibration) return calibration;
      }
      return null;
    }

    function selectedApplicationIsReady() {
      return Boolean(state.mainSave || state.preparedApplication || state.preparedNative);
    }

    function resetContentErrors() {
      state.additionalScanError = "";
      state.compatibilityError = "";
      state.optionError = "";
      state.sourceError = "";
      state.sourceNotice = "";
    }

    function contentGroups() {
      const groups = [];
      const applications = new Map();
      for (const card of state.contentOrder) {
        const metadata = card.entry.metadata;
        const key = metadata.contentKind === "application" ? metadata.setId : null;
        if (key && applications.has(key)) {
          applications.get(key).push(card);
        } else {
          const group = [card];
          groups.push(group);
          if (key) applications.set(key, group);
        }
      }
      return groups;
    }

    function syncContentOrder() {
      const available = new Map(state.sourceFiles.flatMap((file) =>
        (state.preparedDotcodes.get(file) || []).map((entry) => [entry, file]),
      ));
      state.contentOrder = state.contentOrder.filter(({ entry }) => available.has(entry));
      const retained = new Set(state.contentOrder.map(({ entry }) => entry));
      for (const [entry, file] of available) {
        if (!retained.has(entry)) state.contentOrder.push({ file, entry });
      }
      state.contentOrder = contentGroups().flat();
    }

    function additionalScanEntries() {
      const main = new Set(state.mainCards);
      return state.contentOrder.filter((card) => !main.has(card)).map(({ entry }) => entry);
    }

    function moveContent(card, target, after = false) {
      if (state.busy || state.preparing) return;
      const groups = contentGroups();
      const sourceGroup = groups.find((group) => group.includes(card));
      const targetGroup = groups.find((group) => group.includes(target));
      if (!sourceGroup || !targetGroup || sourceGroup === targetGroup) return;
      groups.splice(groups.indexOf(sourceGroup), 1);
      groups.splice(groups.indexOf(targetGroup) + (after ? 1 : 0), 0, sourceGroup);
      state.contentOrder = groups.flat();
      resetContentErrors();
      state.inputNotice = "";
      analyzePreparedDotcodes();
      return true;
    }

    function shiftContent(card, direction) {
      if (![-1, 1].includes(direction)) return;
      const groups = contentGroups();
      const index = groups.findIndex((group) => group.includes(card));
      const target = groups[index + direction];
      if (index < 0 || !target) return;
      return moveContent(card, target[0], direction === 1);
    }

    function additionalScanCapacity() {
      return patcher.constants.MAX_ADDITIONAL_SCANS - (state.preparedNative ? 1 : 0);
    }

    function additionalScanIssue() {
      if (isSaveDataMode() || !state.emulateAdditionalScans) return "";
      if (state.additionalScanError) return state.additionalScanError;
      const count = additionalScanEntries().length;
      const capacity = additionalScanCapacity();
      return count > capacity
        ? `Additional scans exceed the ${capacity}-strip limit. Remove ${count - capacity} strip(s).`
        : "";
    }

    function pruneSourceFile(file) {
      const save = state.preparedSaves.get(file);
      const entries = state.preparedDotcodes.get(file) || [];
      if (entries.length === 0) state.preparedDotcodes.delete(file);
      if (!entries.length && !save?.application && !save?.calibration) {
        state.sourceFiles = state.sourceFiles.filter((candidate) => candidate !== file);
        state.preparedSaves.delete(file);
      }
    }

    function removeSaveFile(file) {
      if (state.busy || state.preparing || fileKind(file) !== "SAV") return;
      state.preparedSaves.delete(file);
      state.preparedDotcodes.delete(file);
      pruneSourceFile(file);
      resetContentErrors();
      state.inputNotice = "";
      analyzePreparedDotcodes();
      return true;
    }

    function removeSaveComponent(file, component) {
      const save = state.preparedSaves.get(file);
      if (state.busy || state.preparing || !save || !["application", "calibration"].includes(component)) return;
      save[component] = null;
      if (component === "application") state.preparedDotcodes.delete(file);
      pruneSourceFile(file);
      resetContentErrors();
      state.inputNotice = "";
      analyzePreparedDotcodes();
      return true;
    }

    function removePreparedDotcode(file, entry) {
      if (state.busy || state.preparing) return;
      const entries = state.preparedDotcodes.get(file);
      if (!entries?.includes(entry)) return;
      const retained = entries.filter((candidate) => candidate !== entry);
      state.preparedDotcodes.set(file, retained);
      const save = state.preparedSaves.get(file);
      if (save?.application) {
        save.application.rawEntries = retained;
        if (!retained.length) save.application = null;
      }
      pruneSourceFile(file);
      resetContentErrors();
      state.inputNotice = "";
      analyzePreparedDotcodes();
      return true;
    }

    function clearKind(kind) {
      if (state.busy || state.preparing) return;
      resetContentErrors();
      if (kind === "rom" || kind === "all") {
        state.romFile = null;
        state.preparedRom = null;
        state.romError = "";
      }
      if (kind === "source" || kind === "all") {
        state.sourceFiles = [];
        state.preparedDotcodes.clear();
        state.preparedSaves.clear();
        state.contentOrder = [];
        state.mainCards = [];
        state.mainSave = null;
        state.preparedApplication = null;
        state.preparedNative = null;
        state.applicationTitle = "";
      }
      state.inputNotice = "";
      return true;
    }

    function contentItems() {
      const calibrationItems = [], saveItems = [];
      const fixedItem = (file, contentKind, title, region, removeAction, role) => ({
        file, entry: null, card: null, contentKind, removeAction, role,
        details: { state: "ready", region, title, index: "\u2014", count: "\u2014", crc32: "\u2014" },
      });
      for (const file of selectedSaveFiles()) {
        const save = state.preparedSaves.get(file);
        if (save?.calibration) {
          calibrationItems.push(fixedItem(file, "calibration", "e-Reader Calibration Data", "\u2014",
            "save-calibration", calibrationItems.length === 0 ? "calibration" : "inactive"));
        }
        if (save?.application && !save.application.rawEntries.length) {
          saveItems.push(fixedItem(file, "application", save.application.metadata.title || "Untitled",
            regionLabel(save.application.metadata.applicationRegion), "save-application", save === state.mainSave ? "main" : "inactive"));
        }
      }
      const main = new Set(state.mainCards);
      const items = [...calibrationItems, ...saveItems, ...state.contentOrder.map((card) => ({
        ...card, card, contentKind: "application", removeAction: "dotcode",
        role: main.has(card) ? "main" : "additional",
        details: {
          state: "ready",
          region: regionLabel(card.entry.metadata.region),
          title: card.entry.metadata.embeddedTitle || "Untitled",
          index: String(card.entry.metadata.cardIndex),
          count: String(card.entry.metadata.cardCount),
          crc32: patcher.crc32(card.entry.bytes).toString(16).toUpperCase().padStart(8, "0"),
        },
      }))];
      const pending = state.sourceFiles.filter((file) =>
        !state.preparedSaves.has(file) && !state.preparedDotcodes.has(file),
      );
      for (const file of [...pending, ...queuedContentFiles()]) {
        const item = fixedItem(file, "application", "\u2014", "Reading\u2026", null, "pending");
        item.details.state = "pending";
        items.push(item);
      }
      return items;
    }

    function refreshDuplicateDotcodes() {
      const unique = createDotcodeIndex();
      let duplicateCount = 0;
      for (const file of [...state.sourceFiles]) {
        const entries = state.preparedDotcodes.get(file);
        if (!entries) continue;
        const retained = entries.filter((entry) => {
          if (unique.has(entry)) { duplicateCount += 1; return false; }
          unique.add(entry);
          return true;
        });
        state.preparedDotcodes.set(file, retained);
        const save = state.preparedSaves.get(file);
        if (save?.application) {
          save.application.rawEntries = retained;
          if (!retained.length) save.application = null;
        }
        pruneSourceFile(file);
      }
      if (duplicateCount) {
        state.inputNotice = [state.inputNotice, `Ignored ${duplicateCount} duplicate dot-code ${duplicateCount === 1 ? "entry" : "entries"}.`].filter(Boolean).join(" ");
      }
    }

    function analyzePreparedDotcodes() {
      state.sourceError = "";
      state.sourceNotice = "";
      state.preparedApplication = null;
      state.preparedNative = null;
      state.mainCards = [];
      state.mainSave = null;
      syncContentOrder();
      state.mainSave = selectedSaveFiles().map((file) => state.preparedSaves.get(file)).find((save) =>
        save?.application && !save.application.rawEntries.length,
      ) || null;
      if (state.mainSave || !state.contentOrder.length) return;
      state.mainCards = contentGroups()[0];
      const entries = state.mainCards.map(({ entry }) => entry);
      try {
        const first = patcher.inspectRawDotcode(entries[0].bytes, entries[0].name);
        if (first.contentKind !== "application") {
          state.preparedNative = entries[0];
          return;
        }
        const indices = new Set(entries.map((entry) => entry.metadata.cardIndex));
        const missing = [];
        for (let index = 1; index <= first.cardCount; index++) {
          if (!indices.has(index)) missing.push(index);
        }
        if (missing.length) {
          state.sourceNotice = `Main content incomplete: ${indices.size} of ${first.cardCount} strips added; missing internal strip(s) ${missing.join(", ")}. Add the remaining files using the drop zone.`;
          return;
        }
        state.preparedApplication = patcher.rawFilesToApplication(entries,
          entries.some((entry) => entry.metadata.embeddedTitle) ? "" : "Untitled");
      } catch (error) {
        state.sourceError = error instanceof Error ? error.message : String(error);
      }
    }

    return Object.freeze({
      state, isSaveDataMode, selectedSaveFiles, selectedDotcodeFiles, selectedCalibration,
      selectedApplicationIsReady, queuedContentFiles, resetContentErrors, contentItems,
      contentGroups, moveContent, shiftContent, additionalScanEntries, additionalScanCapacity, additionalScanIssue,
      removeSaveFile, removeSaveComponent, removePreparedDotcode, clearKind,
      refreshDuplicateDotcodes, analyzePreparedDotcodes,
    });
  }

  return Object.freeze({ createAppModel });
});
