(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./processing_limits.js"));
  } else {
    root.EReaderBrowserRuntime = factory(root.EReaderProcessingLimits);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (limits) {
  "use strict";

  const { MAX_IMAGE_PIXELS, MAX_IMAGE_DIMENSION } = limits;
  const scanWorkerUrl = typeof document === "object" && document.currentScript
    ? new URL("dotcode_worker.js" + new URL(document.currentScript.src).search, document.currentScript.src).href : null;

  async function decodeDotcodeImages(pixels, decoder, options = {}) {
    const direct = () => decoder.decodeDotcodeImages(pixels, options);
    if (!scanWorkerUrl || typeof Worker !== "function") return direct();
    let worker;
    try {
      worker = new Worker(scanWorkerUrl);
    } catch (_error) {
      return direct();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      function finish(action) {
        if (settled) return;
        settled = true;
        worker.terminate();
        try { resolve(action()); } catch (error) { reject(error); }
      }
      worker.onmessage = ({ data }) => finish(() => {
        if (data.error) throw new Error(data.error);
        if (typeof options.onStripDecoded === "function") {
          data.strips.forEach((raw, i) => options.onStripDecoded(raw, data.qualities[i]));
        }
        return data.strips;
      });
      worker.onerror = (event) => {
        event.preventDefault();
        finish(direct);
      };
      worker.onmessageerror = () => finish(direct);
      try {
        worker.postMessage({ width: pixels.width, height: pixels.height, data: pixels.data });
      } catch (_error) {
        finish(direct);
      }
    });
  }

  function wireDropZone(zone, input, onFiles, isBusy) {
    zone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });

    for (const eventName of ["dragenter", "dragover"]) {
      zone.addEventListener(eventName, (event) => {
        event.preventDefault();
        if (!isBusy()) {
          zone.dataset.drag = "true";
        }
      });
    }
    for (const eventName of ["dragleave", "dragend"]) {
      zone.addEventListener(eventName, () => {
        delete zone.dataset.drag;
      });
    }
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      delete zone.dataset.drag;
      if (!isBusy()) {
        void onFiles(event.dataTransfer.files);
      }
    });
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.value = "";
      void onFiles(files);
    });
  }

  function downloadBytes(bytes, filename, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function loadImagePixels(file, inspectDimensions) {
    const encodedDimensions = await inspectDimensions(file);
    let bitmap;
    if (typeof createImageBitmap === "function") {
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (_error) {
        bitmap = await createImageBitmap(file);
      }
    } else {
      const url = URL.createObjectURL(file);
      try {
        const image = new Image();
        image.decoding = "async";
        image.src = url;
        await image.decode();
        bitmap = image;
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    try {
      const width = bitmap.width;
      const height = bitmap.height;
      const pixelCount = width * height;
      if (
        !Number.isSafeInteger(pixelCount) ||
        pixelCount <= 0 ||
        pixelCount > MAX_IMAGE_PIXELS ||
        width > MAX_IMAGE_DIMENSION ||
        height > MAX_IMAGE_DIMENSION
      ) {
        throw new Error(
          `The dot-code image dimensions (${width} x ${height}) are too large to decode safely.`,
        );
      }
      const decodedDimensionsMatch =
        (width === encodedDimensions.width && height === encodedDimensions.height) ||
        (width === encodedDimensions.height && height === encodedDimensions.width);
      if (!decodedDimensionsMatch) {
        throw new Error(`The decoded dimensions of ${file.name} do not match its PNG/JPEG header.`);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("This browser cannot create a 2D canvas for the dot-code scan.");
      }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, width, height);
    } finally {
      if (typeof bitmap.close === "function") bitmap.close();
    }
  }

  return Object.freeze({ downloadBytes, loadImagePixels, wireDropZone, decodeDotcodeImages });
});
