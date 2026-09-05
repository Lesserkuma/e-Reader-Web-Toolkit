(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EReaderAppView = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createAppView(elements, model, fileServices, actions) {
    const {
      state,
      isSaveDataMode,
      queuedContentFiles,
      selectedDotcodeFiles,
      selectedApplicationIsReady,
    } = model;
    const { formatBytes, dotcodeDataFilename } = fileServices;

    function setStatus(message, tone = "") {
      elements.status.textContent = message || "\u00a0";
      if (tone) {
        elements.status.dataset.tone = tone;
      } else {
        delete elements.status.dataset.tone;
      }
    }

    function renderFileCard(card, options) {
      const name = card.querySelector(".file-name");
      const detail = card.querySelector(".file-detail");
      const badge = card.querySelector(".status-badge");
      const remove = card.querySelector("[data-clear]");

      card.dataset.state = options.state;
      name.textContent = options.name;
      if (Object.prototype.hasOwnProperty.call(options, "detailHtml")) {
        detail.innerHTML = options.detailHtml;
      } else {
        detail.textContent = options.detail;
      }
      badge.textContent = options.badge;
      remove.hidden = options.state === "empty";
    }

    function downloadButton(entry, extension) {
      const filename = dotcodeDataFilename(entry, extension);
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ghost-button data-download-button ${extension}-download-button`;
      button.textContent = extension.toUpperCase();
      button.title = `Download ${filename}`;
      button.setAttribute(
        "aria-label",
        extension === "raw"
          ? `Download RAW dot-code data as ${filename}`
          : `Download 2400 ppi vector dot code as ${filename}`,
      );
      button.addEventListener("click", () => actions.downloadDotcode(entry, extension, filename));
      return button;
    }

    function renderContentFileRows() {
      const contentItems = model.contentItems();
      const hasContentItems = contentItems.length > 0;
      elements.contentListHeading.hidden = !hasContentItems;
      elements.contentFileTable.hidden = !hasContentItems;
      const showDataDownloads = contentItems.some(
        ({ entry, contentKind }) => contentKind === "application" && Boolean(entry),
      );
      const showRemoveActions = contentItems.some(({ removeAction }) => Boolean(removeAction));
      elements.dataHeading.hidden = !showDataDownloads;
      elements.crc32Heading.hidden = !showDataDownloads;
      elements.removeHeading.hidden = !showRemoveActions;
      elements.contentFileTable.classList.toggle("has-data", showDataDownloads);
      elements.contentFileTable.classList.toggle("has-remove", showRemoveActions);
      const rows = contentItems.map(({ file, entry, contentKind, details, removeAction }, rowIndex) => {
        const row = document.createElement("tr");
        row.dataset.state = details.state;
        row.dataset.contentKind = contentKind;
        const contentCellText =
          details.index === "\u2014" || details.count === "\u2014"
            ? details.title
            : `${details.title} (${details.index}/${details.count})`;
        const values = [
          ["filename", file.name],
          ["region", details.region],
          ["content", contentCellText],
        ];
        for (const [field, value] of values) {
          const cell = document.createElement("td");
          cell.dataset.field = field;
          cell.textContent = value;
          cell.title = value;
          row.append(cell);
        }
        if (showDataDownloads) {
          const downloadCell = document.createElement("td");
          downloadCell.className = "data-column";
          downloadCell.dataset.field = "data";
          if (entry && contentKind === "application") {
            const actions = document.createElement("div");
            actions.className = "data-download-actions";

            actions.append(downloadButton(entry, "raw"), downloadButton(entry, "svg"));
            downloadCell.append(actions);
          }
          row.append(downloadCell);
          const checksumCell = document.createElement("td");
          checksumCell.className = "crc32-column";
          checksumCell.dataset.field = "crc32";
          checksumCell.textContent = details.crc32;
          checksumCell.title = details.crc32;
          if (entry?.scanQuality?.uncertainFillerBytes.length) {
            const quality = entry.scanQuality;
            const uncertainCount = quality.uncertainFillerBytes.length;
            const note = document.createElement("button");
            note.type = "button";
            note.className = "scan-quality";
            note.textContent = `${uncertainCount} uncertain filler ${uncertainCount === 1 ? "byte" : "bytes"}`;
            const offsets = quality.uncertainFillerBytes.map(
              (offset) => `0x${offset.toString(16).toUpperCase().padStart(4, "0")}`,
            );
            const explanation = document.createElement("div");
            explanation.className = "scan-quality-popover";
            explanation.id = `scan-quality-${rowIndex}`;
            explanation.popover = "auto";
            note.setAttribute("aria-describedby", explanation.id);
            note.popoverTargetElement = explanation;
            note.popoverTargetAction = "show";
            const sections = [
              ["strong", "Explanation"],
              ["p", "The dot code has been verified valid and working, however, the following offset(s) in the unused filler data couldn't be verified. For proper preservation, it is recommended to scan the card again until no uncertain bytes are found."],
              ["code", offsets.join(", "), "scan-quality-offsets"],
            ];
            for (const [tag, text, className] of sections) {
              const part = document.createElement(tag);
              part.textContent = text;
              if (className) part.className = className;
              explanation.append(part);
            }
            const position = () => {
              const rect = note.getBoundingClientRect();
              const width = explanation.offsetWidth;
              const height = explanation.offsetHeight;
              explanation.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
              explanation.style.top = `${Math.max(8, rect.bottom + height <= window.innerHeight - 8 ? rect.bottom : rect.top - height)}px`;
            };
            const show = () => {
              explanation.showPopover();
              position();
            };
            const dismiss = (event) => {
              if (event.type === "resize" || !explanation.contains(event.target)) explanation.hidePopover();
            };
            explanation.addEventListener("toggle", () => {
              const open = explanation.matches(":popover-open");
              if (open) position();
              window[open ? "addEventListener" : "removeEventListener"]("scroll", dismiss, true);
              window[open ? "addEventListener" : "removeEventListener"]("resize", dismiss);
            });
            const help = document.createElement("div");
            help.append(note, explanation);
            help.addEventListener("mouseenter", show);
            help.addEventListener("mouseleave", () => {
              if (!help.contains(document.activeElement)) explanation.hidePopover();
            });
            note.addEventListener("focus", show);
            help.addEventListener("focusout", (event) => {
              if (!help.contains(event.relatedTarget)) explanation.hidePopover();
            });
            checksumCell.removeAttribute("title");
            checksumCell.append(help);
          }
          row.append(checksumCell);
        }
        if (showRemoveActions) {
          const removeCell = document.createElement("td");
          removeCell.className = "remove-column";
          removeCell.dataset.field = "remove";
          if (removeAction) {
            const removeButton = document.createElement("button");
            removeButton.type = "button";
            removeButton.className = "ghost-button small content-remove-button";
            removeButton.textContent = "Remove";
            removeButton.disabled = state.busy || state.preparing;
            let contentLabel;
            if (removeAction === "save-calibration") {
              contentLabel = `calibration data from ${file.name}`;
            } else if (removeAction === "save-application") {
              contentLabel = `saved card content from ${file.name}`;
            } else if (removeAction === "save-file") {
              contentLabel = `SAV source file ${file.name}`;
            } else if (details.title === "\u2014") {
              contentLabel = `dot code from ${file.name}`;
            } else {
              contentLabel = `${details.title}, dot code ${details.index} of ${details.count}`;
            }
            removeButton.title = `Remove ${contentLabel}`;
            removeButton.setAttribute("aria-label", `Remove ${contentLabel}`);
            removeButton.addEventListener("click", () => {
              if (removeAction === "dotcode") {
                actions.removePreparedDotcode(file, entry);
              } else if (removeAction === "save-file") {
                actions.removeSaveFile(file);
              } else {
                actions.removeSaveComponent(
                  file,
                  removeAction === "save-calibration" ? "calibration" : "application",
                );
              }
            });
            removeCell.append(removeButton);
          }
          row.append(removeCell);
        }
        return row;
      });
      elements.contentFileRows.replaceChildren(...rows);
    }

    function renderOptions() {
      const saveDataMode = isSaveDataMode();
      const usingDotcodeContent = selectedDotcodeFiles().length > 0;
      const currentTitle =
        (usingDotcodeContent
          ? state.preparedApplication?.title || state.preparedNative?.metadata?.embeddedTitle
          : state.preparedSave?.application?.metadata?.title) || "Application title";
      elements.outputModeToggle.setAttribute("aria-checked", String(saveDataMode));
      elements.outputModeToggle.disabled = state.busy;
      elements.romSelection.hidden = saveDataMode;
      elements.saveDataOptions.hidden = !saveDataMode;
      elements.saveDataWarning.hidden = Boolean(state.preparedSave?.calibration);
      elements.applicationTitle.disabled = state.busy;
      elements.applicationTitle.placeholder = currentTitle;
      elements.applicationTitle.setAttribute("aria-invalid", String(Boolean(state.optionError)));
      if (elements.applicationTitle.value !== state.applicationTitle) {
        elements.applicationTitle.value = state.applicationTitle;
      }
      elements.buttonIdle.textContent = saveDataMode ? "Build Save Data" : "Build Standalone ROM";
      elements.buttonWorking.textContent = saveDataMode
        ? "Generating save data…"
        : "Validating and building…";
    }

    function renderInputs() {
      renderOptions();
      if (!state.romFile) {
        renderFileCard(elements.romSelection, {
          state: "empty",
          name: "No ROM selected.",
          detailHtml: isSaveDataMode()
            ? "A base ROM is not required for Save Data output."
            : "Supported: <b>e-Reader (USA)</b> or <b>Card e-Reader+ (Japan)</b>",
          badge: isSaveDataMode() ? "Optional" : "Missing",
        });
      } else {
        renderFileCard(elements.romSelection, {
          state: state.romError ? "error" : state.preparedRom ? "ready" : "pending",
          name: state.romFile.name,
          detail: state.romError || `${formatBytes(state.romFile.size)} · GBA ROM`,
          badge: state.romError ? "Invalid" : state.preparedRom ? "Validated" : "Reading",
        });
      }

      renderContentFileRows();
      elements.clearContentButton.hidden =
        state.sourceFiles.length === 0 && queuedContentFiles().length === 0;

      const hasAnyFiles = Boolean(state.romFile || state.sourceFiles.length);
      const sourceReady = selectedApplicationIsReady();
      const outputReady = isSaveDataMode()
        ? !state.preparedNative
        : Boolean(
            state.romFile &&
              state.preparedRom?.file === state.romFile &&
              !state.romError &&
              !state.compatibilityError,
          );
      const ready = Boolean(
        sourceReady &&
          outputReady &&
          !state.sourceError &&
          !state.sourceNotice &&
          !state.optionError &&
          !state.preparing &&
          !state.busy,
      );
      elements.clearButton.disabled = !hasAnyFiles || state.busy || state.preparing;
      elements.buildButton.disabled = !ready;
      elements.fileInput.disabled = state.busy;
      document.querySelectorAll("[data-clear]").forEach((button) => {
        button.disabled = state.busy || state.preparing;
      });
    }

    function refreshInputStatus() {
      if (state.preparing) {
        return;
      }
      if (state.optionError) {
        setStatus(state.optionError, "error");
      } else if (!isSaveDataMode() && state.romError) {
        setStatus(state.romError, "error");
      } else if (state.sourceError) {
        setStatus(state.sourceError, "error");
      } else if (!isSaveDataMode() && state.compatibilityError) {
        setStatus(state.compatibilityError, "error");
      } else if (state.sourceNotice) {
        setStatus(state.sourceNotice, "warning");
      } else if (state.inputNotice) {
        setStatus(state.inputNotice, "warning");
      } else if (isSaveDataMode() && state.preparedNative) {
        setStatus(
          "This card type cannot be stored as an e-Reader saved application. Use ROM output instead.",
          "warning",
        );
      } else if (isSaveDataMode() && !selectedApplicationIsReady()) {
        if (state.preparedSave?.calibration && selectedDotcodeFiles().length === 0) {
          setStatus("Calibration data imported. Add RAW strips or dot-code images to continue.");
        } else {
          setStatus("Add a SAV with an application, RAW strips, or dot-code images to continue.");
        }
      } else if (isSaveDataMode()) {
        setStatus("Content is complete and validated. Ready to build save data.");
      } else if (!state.romFile && state.sourceFiles.length === 0) {
        setStatus("Add a base ROM and content files to continue.");
      } else if (!state.romFile) {
        setStatus("Add a supported base ROM to continue.");
      } else if (state.sourceFiles.length === 0) {
        setStatus("Add a SAV, RAW strips, or dot-code images to continue.");
      } else if (!selectedApplicationIsReady()) {
        setStatus("Add application content to continue.");
      } else {
        setStatus("Inputs are complete and validated. Ready to build.");
      }
    }
    return Object.freeze({ setStatus, renderInputs, refreshInputStatus });
  }

  return Object.freeze({ createAppView });
});
