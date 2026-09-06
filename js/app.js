(function () {
  "use strict";

  const elements = {
    fileInput: document.querySelector("#file-input"),
    fileDropZone: document.querySelector("#file-drop-zone"),
    romSelection: document.querySelector("#rom-selection"),
    contentListHeading: document.querySelector("#content-list-heading"),
    clearContentButton: document.querySelector("#clear-content-button"),
    contentFileTable: document.querySelector("#content-file-table"),
    contentFileRows: document.querySelector("#content-file-rows"),
    dataHeading: document.querySelector("#data-heading"),
    crc32Heading: document.querySelector("#crc32-heading"),
    removeHeading: document.querySelector("#remove-heading"),
    clearButton: document.querySelector("#clear-button"),
    outputModeToggle: document.querySelector("#output-mode-toggle"),
    saveDataOptions: document.querySelector("#save-data-options"),
    romOptions: document.querySelector("#rom-options"),
    emulateAdditionalScans: document.querySelector("#emulate-additional-scans"),
    saveDataWarning: document.querySelector("#save-data-warning"),
    applicationTitle: document.querySelector("#application-title"),
    buildButton: document.querySelector("#build-button"),
    buttonIdle: document.querySelector(".button-idle"),
    buttonWorking: document.querySelector(".button-working"),
    status: document.querySelector("#status-region"),
  };

  const modules = {
    patcher: window.EReaderPatcher,
    dotcode: window.EReaderDotcodeScan,
    zipArchive: window.EReaderZipArchive,
    inputFiles: window.EReaderInputFiles,
    browserRuntime: window.EReaderBrowserRuntime,
    svg: window.EReaderSvg,
    saveData: window.EReaderSaveData,
    model: window.EReaderAppModel,
    view: window.EReaderAppView,
    importer: window.EReaderAppImport,
    output: window.EReaderAppOutput,
  };
  function startupError(message) {
    elements.buildButton.disabled = true;
    elements.status.textContent = message;
    elements.status.dataset.tone = "error";
  }
  if (Object.values(modules).some((module) => !module)) {
    startupError("A required processing module could not be loaded.");
    return;
  }
  if (!window.File || !File.prototype.arrayBuffer || !window.TextDecoder) {
    startupError("This browser does not provide the file and text APIs required by the patcher.");
    return;
  }
  if (!window.crypto?.subtle || typeof window.crypto.subtle.digest !== "function") {
    startupError("This browser does not provide the secure hashing API required by the patcher.");
    return;
  }
  const { patcher, dotcode, zipArchive, browserRuntime } = modules;
  const fileServices = modules.inputFiles.createFileServices(patcher, dotcode);
  const svgServices = modules.svg.createSvgServices(patcher, {
    readFileBytes: fileServices.readFileBytes,
  });
  const saveData = modules.saveData.createSaveDataServices(patcher);
  const model = modules.model.createAppModel(patcher, fileServices);
  const { state } = model;
  const actions = {};
  const view = modules.view.createAppView(elements, model, fileServices, actions);
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const importer = modules.importer.createImportController({
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
  });
  const output = modules.output.createOutputController({
    model,
    view,
    elements,
    patcher,
    saveData,
    fileServices,
    browserRuntime,
    svgServices,
    nextFrame,
  });
  function updateModel(action, ...args) {
    if (!model[action](...args)) return;
    elements.fileInput.value = "";
    view.renderInputs();
    view.refreshInputStatus();
  }
  Object.assign(actions, {
    removeSaveFile: (file) => updateModel("removeSaveFile", file),
    removeSaveComponent: (file, component) => updateModel("removeSaveComponent", file, component),
    removePreparedDotcode: (file, entry) => updateModel("removePreparedDotcode", file, entry),
    moveContent: (card, target, after) => updateModel("moveContent", card, target, after),
    shiftContent: (card, direction) => updateModel("shiftContent", card, direction),
    downloadDotcode: output.downloadDotcode,
  });
  browserRuntime.wireDropZone(
    elements.fileDropZone,
    elements.fileInput,
    importer.enqueueFiles,
    () => state.busy,
  );
  elements.emulateAdditionalScans.addEventListener("change", () => {
    if (state.busy) return;
    state.emulateAdditionalScans = elements.emulateAdditionalScans.checked;
    view.renderInputs();
    view.refreshInputStatus();
  });
  elements.clearButton.addEventListener("click", () => updateModel("clearKind", "all"));
  document.querySelectorAll("[data-clear]").forEach((button) => {
    button.addEventListener("click", () => updateModel("clearKind", button.dataset.clear));
  });
  elements.buildButton.addEventListener("click", output.build);
  elements.outputModeToggle.addEventListener("click", () => {
    if (state.busy) return;
    state.outputMode = model.isSaveDataMode() ? "rom" : "save";
    state.optionError = "";
    view.renderInputs();
    view.refreshInputStatus();
  });
  elements.applicationTitle.addEventListener("input", () => {
    state.applicationTitle = elements.applicationTitle.value;
    state.optionError = "";
    view.renderInputs();
    view.refreshInputStatus();
  });
  view.renderInputs();
  view.refreshInputStatus();
})();
