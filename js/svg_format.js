(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./processing_limits.js"), require("./dotcode_layout.js"));
  } else {
    root.EReaderSvgFormat = factory(root.EReaderProcessingLimits, root.EReaderDotcodeLayout);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (limits, layout) {
  "use strict";

  const SVG_EXTENSION = ".svg";

  const RAW_METADATA_ID = "ereader-raw-data";

  const DOTCODE_BYTES_PER_BLOCK = layout.BYTES_PER_BLOCK;

  const DOTCODE_RENDER_DPI = 2400;

  const DOTCODE_RENDER_SCALE = 7;

  const DOTCODE_GRID_DPI = DOTCODE_RENDER_DPI / DOTCODE_RENDER_SCALE;

  const DOTCODE_DATA_DOT_SIZE = 6;

  const DOTCODE_DATA_DOT_RADIUS = 0;

  const DOTCODE_SYNC_MARKER_DIAMETER = 5 * DOTCODE_RENDER_SCALE;

  const MAX_DOTCODE_IMAGE_PIXELS = limits.MAX_IMAGE_PIXELS;

  const MAX_CANVAS_DIMENSION = limits.MAX_IMAGE_DIMENSION;

  const MAX_SVG_FILE_BYTES = limits.MAX_IMAGE_FILE_BYTES;

  const DEFAULT_SVG_RASTER_DPI = 1200;

  const MAX_SVG_RASTER_DPI = 9600;

  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

  const constants = Object.freeze({
    SVG_EXTENSION,
    RAW_METADATA_ID,
    DOTCODE_BYTES_PER_BLOCK,
    DOTCODE_RENDER_DPI,
    DOTCODE_RENDER_SCALE,
    DOTCODE_GRID_DPI,
    DOTCODE_DATA_DOT_SIZE,
    DOTCODE_DATA_DOT_RADIUS,
    DOTCODE_SYNC_MARKER_DIAMETER,
    MAX_DOTCODE_IMAGE_PIXELS,
    MAX_CANVAS_DIMENSION,
    MAX_SVG_FILE_BYTES,
    DEFAULT_SVG_RASTER_DPI,
    MAX_SVG_RASTER_DPI,
    SVG_NAMESPACE,
  });

  const XML_NAME_PATTERN = /^[:A-Z_a-z][:A-Z_a-z0-9.\-]*/;

  const XML_WHITESPACE_PATTERN = /[\t\n\r ]/;

  function extensionOf(filename) {
    const match = /\.([^.]+)$/.exec(filename);
    return match ? `.${match[1].toLocaleLowerCase("en-US")}` : "";
  }

  function isSvgFile(file) {
    const filename = typeof file === "string" ? file : file && file.name;
    return typeof filename === "string" && extensionOf(filename) === SVG_EXTENSION;
  }

  function decodeSvgText(bytes, label) {
    let encoding = "utf-8";
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = "utf-16le";
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      encoding = "utf-16be";
    } else if (
      bytes.length >= 4 &&
      bytes[0] === 0x3c &&
      bytes[1] === 0x00 &&
      bytes[2] !== 0x00 &&
      bytes[3] === 0x00
    ) {
      encoding = "utf-16le";
    } else if (
      bytes.length >= 4 &&
      bytes[0] === 0x00 &&
      bytes[1] === 0x3c &&
      bytes[2] === 0x00 &&
      bytes[3] !== 0x00
    ) {
      encoding = "utf-16be";
    }
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} is not valid ${encoding.toUpperCase()} XML: ${message}`);
    }
  }

  function xmlError(label, detail) {
    return new Error(`${label} has malformed RAW metadata: ${detail}`);
  }

  function findXmlTagEnd(source, start, label) {
    let quote = "";
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) {
          quote = "";
        } else if (character === "<") {
          throw xmlError(label, "an attribute value contains '<'");
        }
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        return index;
      }
    }
    throw xmlError(label, "an XML tag is not terminated");
  }

  function decodeXmlAttribute(value, label) {
    let result = "";
    let offset = 0;
    const referencePattern = /&([^;]+);/g;
    let match;
    while ((match = referencePattern.exec(value)) !== null) {
      if (value.slice(offset, match.index).includes("&")) {
        throw xmlError(label, "an attribute contains an invalid entity reference");
      }
      result += value.slice(offset, match.index);
      const reference = match[1];
      const namedEntities = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        quot: '"',
      };
      if (Object.prototype.hasOwnProperty.call(namedEntities, reference)) {
        result += namedEntities[reference];
      } else {
        const numeric = /^#([0-9]+)$/.exec(reference);
        const hexadecimal = /^#x([0-9a-f]+)$/i.exec(reference);
        const codePoint = numeric
          ? Number.parseInt(numeric[1], 10)
          : hexadecimal
            ? Number.parseInt(hexadecimal[1], 16)
            : -1;
        if (
          !Number.isInteger(codePoint) ||
          codePoint <= 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          throw xmlError(label, `unsupported entity reference '&${reference};'`);
        }
        result += String.fromCodePoint(codePoint);
      }
      offset = match.index + match[0].length;
    }
    if (value.slice(offset).includes("&")) {
      throw xmlError(label, "an attribute contains an unterminated entity reference");
    }
    return result + value.slice(offset);
  }

  function parseXmlStartTag(source, start, end, label) {
    let offset = start + 1;
    const nameMatch = XML_NAME_PATTERN.exec(source.slice(offset));
    if (!nameMatch) {
      throw xmlError(label, "an XML element has no valid name");
    }
    const name = nameMatch[0];
    offset += name.length;
    const attributes = new Map();
    let selfClosing = false;

    while (offset < end) {
      let hadWhitespace = false;
      while (offset < end && XML_WHITESPACE_PATTERN.test(source[offset])) {
        hadWhitespace = true;
        offset += 1;
      }
      if (offset >= end) {
        break;
      }
      if (source[offset] === "/") {
        if (source.slice(offset + 1, end).trim() !== "") {
          throw xmlError(label, "a self-closing XML tag has trailing data");
        }
        selfClosing = true;
        offset = end;
        break;
      }
      if (!hadWhitespace) {
        throw xmlError(label, `attributes on <${name}> are not separated by whitespace`);
      }
      const attributeMatch = XML_NAME_PATTERN.exec(source.slice(offset));
      if (!attributeMatch) {
        throw xmlError(label, `<${name}> contains an invalid attribute name`);
      }
      const attributeName = attributeMatch[0];
      offset += attributeName.length;
      while (offset < end && XML_WHITESPACE_PATTERN.test(source[offset])) {
        offset += 1;
      }
      if (source[offset] !== "=") {
        throw xmlError(label, `attribute '${attributeName}' has no value`);
      }
      offset += 1;
      while (offset < end && XML_WHITESPACE_PATTERN.test(source[offset])) {
        offset += 1;
      }
      const quote = source[offset];
      if (quote !== '"' && quote !== "'") {
        throw xmlError(label, `attribute '${attributeName}' is not quoted`);
      }
      const valueStart = offset + 1;
      const valueEnd = source.indexOf(quote, valueStart);
      if (valueEnd < 0 || valueEnd > end) {
        throw xmlError(label, `attribute '${attributeName}' is not terminated`);
      }
      if (attributes.has(attributeName)) {
        throw xmlError(label, `attribute '${attributeName}' occurs more than once`);
      }
      attributes.set(attributeName, decodeXmlAttribute(source.slice(valueStart, valueEnd), label));
      offset = valueEnd + 1;
    }
    return { name, attributes, selfClosing };
  }

  function parseXmlEndTag(source, start, end, label) {
    const contents = source.slice(start + 2, end).trim();
    const match = XML_NAME_PATTERN.exec(contents);
    if (!match || match[0].length !== contents.length) {
      throw xmlError(label, "an XML closing tag is malformed");
    }
    return match[0];
  }

  function localXmlName(name) {
    return name.slice(name.lastIndexOf(":") + 1);
  }

  function createMetadataReader(patcher) {
    const { crc32, inspectScanCard } = patcher;
    function parseRawMetadataCandidate(candidate, label) {
      const { attributes } = candidate;
      const encoding = attributes.get("data-encoding");
      if (typeof encoding !== "string" || encoding.toLowerCase() !== "hex") {
        throw xmlError(label, "expected data-encoding='hex'");
      }
      const byteLengthText = attributes.get("data-byte-length");
      if (!/^(?:0|[1-9][0-9]*)$/.test(byteLengthText || "")) {
        throw xmlError(label, "data-byte-length is not a decimal byte count");
      }
      const byteLength = Number(byteLengthText);
      if (
        byteLength !== patcher.constants.RAW_LONG_SIZE &&
        byteLength !== patcher.constants.RAW_SHORT_SIZE
      ) {
        throw xmlError(
          label,
          `embedded RAW length ${byteLength} is not a supported long or short strip`,
        );
      }
      if (candidate.hasChildElement) {
        throw xmlError(label, "the RAW hex payload must not contain child elements");
      }
      const hex = candidate.text.replace(/[\t\n\r ]/g, "");
      if (!/^[0-9a-f]*$/i.test(hex)) {
        throw xmlError(label, "the RAW payload contains non-hexadecimal characters");
      }
      if (hex.length !== byteLength * 2) {
        throw xmlError(
          label,
          `mismatched byte length (declared ${byteLength}, found ${hex.length / 2})`,
        );
      }
      const raw = new Uint8Array(byteLength);
      for (let index = 0; index < byteLength; index += 1) {
        raw[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
      }

      const expectedCrc = attributes.get("data-crc32");
      if (!/^[0-9a-f]{8}$/i.test(expectedCrc || "")) {
        throw xmlError(
          label,
          "data-crc32 is required and must contain exactly eight hexadecimal digits",
        );
      }
      const actualCrc = crc32(raw).toString(16).padStart(8, "0");
      if (actualCrc.toLowerCase() !== expectedCrc.toLowerCase()) {
        throw xmlError(label, "the embedded RAW CRC32 does not match its payload");
      }
      try {
        inspectScanCard(raw, `${label} embedded RAW metadata`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw xmlError(label, `the embedded RAW strip is invalid (${message})`);
      }
      return raw;
    }

    function extractSvgRawMetadata(svgText, label = "SVG input") {
      if (typeof svgText !== "string") {
        throw new TypeError("SVG input must be text");
      }
      const stack = [];
      const candidates = [];
      let activeCandidate = null;
      let offset = 0;
      let rootSeen = false;
      let rootClosed = false;

      function appendText(value) {
        if (activeCandidate) {
          activeCandidate.text += value;
        } else if (stack.length === 0 && value.trim() !== "") {
          throw xmlError(label, "non-whitespace text occurs outside the root element");
        }
      }

      while (offset < svgText.length) {
        const tagStart = svgText.indexOf("<", offset);
        if (tagStart < 0) {
          appendText(svgText.slice(offset));
          offset = svgText.length;
          break;
        }
        appendText(svgText.slice(offset, tagStart));

        if (svgText.startsWith("<!--", tagStart)) {
          const end = svgText.indexOf("-->", tagStart + 4);
          if (end < 0) {
            throw xmlError(label, "an XML comment is not terminated");
          }
          offset = end + 3;
          continue;
        }
        if (svgText.startsWith("<![CDATA[", tagStart)) {
          const end = svgText.indexOf("]]>", tagStart + 9);
          if (end < 0) {
            throw xmlError(label, "a CDATA section is not terminated");
          }
          appendText(svgText.slice(tagStart + 9, end));
          offset = end + 3;
          continue;
        }
        if (svgText.startsWith("<?", tagStart)) {
          const end = svgText.indexOf("?>", tagStart + 2);
          if (end < 0) {
            throw xmlError(label, "an XML processing instruction is not terminated");
          }
          offset = end + 2;
          continue;
        }
        if (svgText.startsWith("<!", tagStart)) {
          throw xmlError(label, "document type and entity declarations are not allowed");
        }

        const tagEnd = findXmlTagEnd(svgText, tagStart + 1, label);
        if (svgText.startsWith("</", tagStart)) {
          const name = parseXmlEndTag(svgText, tagStart, tagEnd, label);
          const open = stack.pop();
          if (!open || open.name !== name) {
            throw xmlError(label, `closing tag </${name}> does not match its opening tag`);
          }
          if (open.candidate) {
            activeCandidate = null;
          }
          if (stack.length === 0) {
            rootClosed = true;
          }
        } else {
          if (rootClosed) {
            throw xmlError(label, "more than one root element is present");
          }
          const parsed = parseXmlStartTag(svgText, tagStart, tagEnd, label);
          if (stack.length === 0) {
            if (rootSeen || localXmlName(parsed.name) !== "svg") {
              throw xmlError(label, "the document root is not a single <svg> element");
            }
            rootSeen = true;
          }
          if (activeCandidate) {
            activeCandidate.hasChildElement = true;
          }
          let candidate = null;
          if (
            localXmlName(parsed.name) === "metadata" &&
            parsed.attributes.get("id") === RAW_METADATA_ID
          ) {
            candidate = {
              attributes: parsed.attributes,
              hasChildElement: false,
              text: "",
            };
            candidates.push(candidate);
            if (!parsed.selfClosing) {
              activeCandidate = candidate;
            }
          }
          if (!parsed.selfClosing) {
            stack.push({ name: parsed.name, candidate });
          } else if (stack.length === 0) {
            rootClosed = true;
          }
        }
        offset = tagEnd + 1;
      }

      if (!rootSeen || !rootClosed || stack.length !== 0) {
        throw xmlError(label, "the SVG XML document is incomplete");
      }
      if (candidates.length === 0) {
        return null;
      }
      if (candidates.length !== 1) {
        throw xmlError(label, "more than one e-Reader RAW metadata element is present");
      }
      return parseRawMetadataCandidate(candidates[0], label);
    }
    return extractSvgRawMetadata;
  }

  return Object.freeze({ constants, isSvgFile, decodeSvgText, createMetadataReader });
});
