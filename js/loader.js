(function () {
  "use strict";

  const baseUrl = new URL(document.currentScript.src);
  const scripts = [
    "processing_limits.js",
    "binary.js",
    "card_constants.js",
    "reed_solomon.js",
    "dotcode_layout.js",
    "title_codec.js",
    "raw_codec.js",
    "save_format.js",
    "application_codec.js",
    "patcher.js",
    "dotcode_math.js",
    "dotcode_sampling.js",
    "dotcode_recovery.js",
    "dotcode_scan.js",
    "svg_format.js",
    "svg_renderer.js",
    "svg_raster.js",
    "svg.js",
    "save_data.js",
    "zip_archive.js",
    "input_files.js",
    "browser_runtime.js",
    "app_model.js",
    "app_view.js",
    "app_import.js",
    "app_output.js",
    "app.js",
  ];

  for (const source of scripts) {
    const script = document.createElement("script");
    script.src = new URL(source + baseUrl.search, baseUrl).href;
    script.async = false;
    document.head.append(script);
  }
})();
