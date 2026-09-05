(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./binary.js"),
      require("./card_constants.js"),
      require("./title_codec.js"),
      require("./save_format.js"),
      require("./raw_codec.js"),
    );
  } else {
    root.EReaderApplicationCodec = factory(
      root.EReaderBinary,
      root.EReaderCardConstants,
      root.EReaderTitleCodec,
      root.EReaderSaveFormat,
      root.EReaderRawCodec,
    );
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function (binary, constants, titleModule, saveModule, rawModule) {
    "use strict";

    const {
      asBytes,
      asciiBytes,
      concatBytes,
      bytesEqual,
      bytesToHex,
      readU16LE,
      readU32LE,
      writeU16LE,
      writeU32LE,
    } = binary;
    const {
      UNTITLED_CONTENT_TITLE,
      PROGRAM_TYPE_CARD_HEADER_SHIFT,
      JPN_SAVED_REGION_CODE,
      PROGRAM_EXECUTION_Z80,
      PROGRAM_EXECUTION_GBA,
      PROGRAM_EXECUTION_NES,
    } = constants;
    const { RAW_LONG_BIN_SIZE } = rawModule;

    function createApplicationCodec(
      ErrorType = Error,
      titles = titleModule.createTitleCodec(ErrorType),
      saveFormat = saveModule.createSaveFormat(ErrorType, titles),
      rawCodec = rawModule.createRawCodec(ErrorType),
    ) {
      const {
        firstNull,
        decodeShiftJis,
        japaneseShortTitleToShiftJis,
        decodeJapaneseShortTitle,
        decodeUsaTitle,
        encodeUsaTitle,
        decodeExtendedTitleField,
        decodeDirectJapaneseViewerTitle,
        decodeNativeTitle,
        nativeTypeFallbackTitle,
        encodeShiftJis,
      } = titles;
      const { dotcodeCardHeaderByte, dotcodeSaveLayout, rawExportPreservesContent } = saveFormat;
      const { encodeRawDotcode, decodeRawDotcodeDetails } = rawCodec;

      const VIEWER_COMPACT_TITLE_OFFSET = 13;

      const VIEWER_COMPACT_TITLE_SIZE = 19;

      const APPLICATION_CARD_TYPES = new Set([0x02, 0x03, 0x04, 0x05, 0x0e, 0x1e]);

      const NATIVE_CARD_TYPES = new Set([
        0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0f, 0x1f,
      ]);

      function parseDecodedApplicationStrip(app, label, physicalCardType = null) {
        const header = app.subarray(0, 12);
        const region = header[0] & 0x0f;
        const cardType = physicalCardType === null ? header[1] >>> 4 : physicalCardType;
        if (![0, 1, 2].includes(region)) {
          throw new ErrorType(`${label} uses unsupported e-Reader region ${region}`);
        }
        if (!APPLICATION_CARD_TYPES.has(cardType)) {
          throw new ErrorType(`${label} is not an e-Reader application card`);
        }

        const cardCount = (header[4] >>> 5) | ((header[5] & 1) << 3);
        const cardIndex = (header[4] & 0x1e) >>> 1;
        const encodedSize = (header[6] << 7) | (header[5] >>> 1);
        if (!cardCount || cardIndex < 1 || cardIndex > cardCount) {
          throw new ErrorType(`${label} has an invalid card-set index`);
        }

        const extendedApplicationHeader = (cardType & 0x0f) === 0x0e;
        const setTitleSize = extendedApplicationHeader ? 33 : 17;
        const cardTitleSize = header[8] & 0x02 ? 0 : extendedApplicationHeader ? 33 : 0x15;
        const payloadOffset = 12 + setTitleSize + cardTitleSize * cardCount;
        if (payloadOffset > app.length) {
          throw new ErrorType(`${label} has an invalid title area`);
        }

        const titleField = app.subarray(12, 12 + setTitleSize);
        const titleArea = app.subarray(12, payloadOffset);
        let embeddedTitleBytes = firstNull(titleField);
        let embeddedTitle;
        let saveTitleBytes;
        let titleEncoding;
        try {
          if (extendedApplicationHeader) {
            let decodedTitle = decodeExtendedTitleField(titleField, region, `${label} title`);
            if (!decodedTitle && cardType === 0x0e && cardTitleSize > 0) {
              const cardTitlesOffset = 12 + setTitleSize;
              for (let offset = 0; offset < cardTitleSize * cardCount; offset += cardTitleSize) {
                const cardTitleField = app.subarray(
                  cardTitlesOffset + offset,
                  cardTitlesOffset + offset + cardTitleSize,
                );
                decodedTitle = decodeExtendedTitleField(
                  cardTitleField,
                  region,
                  `${label} card title`,
                );
                if (decodedTitle) {
                  embeddedTitleBytes = firstNull(cardTitleField);
                  break;
                }
              }
            }
            if (decodedTitle) {
              embeddedTitle = decodedTitle.title;
              saveTitleBytes = decodedTitle.saveTitleBytes;
              titleEncoding = decodedTitle.titleEncoding;
            } else {
              embeddedTitle = "";
              embeddedTitleBytes = new Uint8Array();
              saveTitleBytes = new Uint8Array();
              titleEncoding = "none";
            }
          } else if (region === 1) {
            embeddedTitle = decodeUsaTitle(embeddedTitleBytes, `${label} title`);
            saveTitleBytes = embeddedTitleBytes.slice();
            titleEncoding =
              embeddedTitleBytes.length === 0
                ? "none"
                : embeddedTitleBytes.every((value) => value >= 0x20 && value < 0x7f)
                  ? "ASCII"
                  : "e-Reader USA 1-byte";
          } else {
            embeddedTitle = decodeJapaneseShortTitle(embeddedTitleBytes, `${label} title`);
            saveTitleBytes = japaneseShortTitleToShiftJis(embeddedTitleBytes, `${label} title`);
            titleEncoding = embeddedTitleBytes.length === 0 ? "none" : "e-Reader Japanese 1-byte";
          }
        } catch (error) {
          if (error instanceof ErrorType) {
            throw error;
          }
          throw new ErrorType(`${label} has an invalid application title`);
        }
        if (embeddedTitleBytes.length >= 0x24) {
          throw new ErrorType("Application title is too long for the save record");
        }

        const headerTail = header.slice(7, 12);
        const setId = [
          header[0].toString(16).padStart(2, "0"),
          header[1].toString(16).padStart(2, "0"),
          cardType.toString(16).padStart(2, "0"),
          String(cardCount),
          String(encodedSize),
          bytesToHex(headerTail),
          bytesToHex(titleArea),
          String(payloadOffset),
        ].join(":");
        return {
          app,
          header: header.slice(),
          region,
          cardType,
          cardCount,
          cardIndex,
          encodedSize,
          payloadOffset,
          embeddedTitle,
          embeddedTitleBytes: embeddedTitleBytes.slice(),
          saveTitleBytes,
          titleEncoding,
          setId,
        };
      }

      function inspectDecodedDotcode(decoded, label = "RAW input") {
        if (![0, 1, 2].includes(decoded.region)) {
          throw new ErrorType(`${label} uses unsupported e-Reader region ${decoded.region}`);
        }
        if (decoded.cardType >= 0x10 && decoded.cardType <= 0x1d) {
          let embeddedTitle = "";
          let viewerTitle;
          let titleEncoding;
          const compactTitleField = decoded.app.subarray(
            VIEWER_COMPACT_TITLE_OFFSET,
            VIEWER_COMPACT_TITLE_OFFSET + VIEWER_COMPACT_TITLE_SIZE,
          );
          if (decoded.region === 1) {
            viewerTitle = decodeUsaTitle(compactTitleField, `${label} Pokémon Viewer title`);
            titleEncoding = viewerTitle ? "e-Reader USA 1-byte" : "none";
          } else {
            viewerTitle = decodeDirectJapaneseViewerTitle(decoded.app);
            if (viewerTitle !== null) {
              titleEncoding = "Shift-JIS";
            } else {
              viewerTitle = decodeJapaneseShortTitle(
                compactTitleField,
                `${label} Pokémon Viewer title`,
              );
              titleEncoding = viewerTitle ? "e-Reader Japanese 1-byte" : "none";
            }
          }
          embeddedTitle = viewerTitle ? `Pokémon Viewer: ${viewerTitle}` : "Pokémon Viewer";
          return Object.freeze({
            contentKind: "pokedex",
            region: decoded.region,
            cardType: decoded.cardType,
            cardCount: 1,
            cardIndex: 1,
            encodedSize: 0,
            payloadOffset: 12,
            embeddedTitle,
            embeddedTitleBytes: new Uint8Array(),
            titleEncoding,
            setId: `pokedex:${bytesToHex(decoded.app)}`,
          });
        }
        if (!APPLICATION_CARD_TYPES.has(decoded.cardType)) {
          if (!NATIVE_CARD_TYPES.has(decoded.cardType)) {
            throw new ErrorType(
              `${label} uses unsupported e-Reader card type 0x${decoded.cardType.toString(16).toUpperCase().padStart(2, "0")}`,
            );
          }
          const decodedTitle = decodeNativeTitle(decoded);
          const genericTitle = nativeTypeFallbackTitle(decoded.region, decoded.cardType);
          const embeddedTitle = decodedTitle
            ? decodedTitle.title
            : (genericTitle ??
              `Type 0x${decoded.cardType.toString(16).toUpperCase().padStart(2, "0")}`);
          return Object.freeze({
            contentKind: "native",
            region: decoded.region,
            cardType: decoded.cardType,
            cardCount: 1,
            cardIndex: 1,
            encodedSize: 0,
            payloadOffset: 12,
            embeddedTitle,
            embeddedTitleBytes: new Uint8Array(),
            titleEncoding: decodedTitle
              ? decodedTitle.titleEncoding
              : genericTitle
                ? "generic card-type name"
                : "none",
            setId: `native:${bytesToHex(decoded.app)}`,
          });
        }
        const parsed = parseDecodedApplicationStrip(decoded.app, label, decoded.cardType);
        return Object.freeze({
          contentKind: "application",
          region: parsed.region,
          cardType: parsed.cardType,
          cardCount: parsed.cardCount,
          cardIndex: parsed.cardIndex,
          encodedSize: parsed.encodedSize,
          payloadOffset: parsed.payloadOffset,
          embeddedTitle: parsed.embeddedTitle,
          embeddedTitleBytes: parsed.embeddedTitleBytes,
          titleEncoding: parsed.titleEncoding,
          setId: parsed.setId,
        });
      }

      function inspectRawDotcode(rawInput, label = "RAW input") {
        return inspectDecodedDotcode(decodeRawDotcodeDetails(rawInput, label), label);
      }

      function normalizeRawFile(file, index) {
        if (!file || typeof file.name !== "string") {
          throw new TypeError(`RAW file ${index + 1} has no name`);
        }
        if (!/\.raw$/i.test(file.name)) {
          throw new ErrorType(`RAW source must have a .raw extension: ${file.name}`);
        }
        return {
          name: file.name,
          bytes: asBytes(file.bytes ?? file.data, file.name),
        };
      }

      function selectRawSet(rawFiles, selectedName = null) {
        const files = Array.from(rawFiles, normalizeRawFile);
        if (files.length === 0) {
          throw new ErrorType("No RAW strips were supplied");
        }

        const inspected = files.map((file) => ({
          ...file,
          metadata: inspectRawDotcode(file.bytes, file.name),
        }));
        const hasSelectedName =
          selectedName !== null && selectedName !== undefined && String(selectedName).length > 0;
        let selectedFile = inspected[0];
        if (hasSelectedName) {
          const normalizedSelectedName = String(selectedName)
            .replace(/^.*[\\/]/, "")
            .toLocaleLowerCase("en-US");
          selectedFile = inspected.find(
            (file) =>
              file.name.replace(/^.*[\\/]/, "").toLocaleLowerCase("en-US") ===
              normalizedSelectedName,
          );
          if (!selectedFile) {
            throw new ErrorType(`no RAW strip found for ${selectedName}`);
          }
        }

        const distinctSetIds = new Set(inspected.map((file) => file.metadata.setId));
        if (!hasSelectedName && distinctSetIds.size > 1) {
          throw new ErrorType(
            "multiple RAW content sets were selected; choose the strips for one content set only",
          );
        }
        return inspected
          .filter((file) => file.metadata.setId === selectedFile.metadata.setId)
          .sort(
            (left, right) =>
              left.metadata.cardIndex - right.metadata.cardIndex ||
              left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
          )
          .map(({ name, bytes }) => ({ name, bytes }));
      }

      function applicationTitleForSave(parsed, fallbackTitle, label) {
        let titleBytes = parsed.saveTitleBytes.slice();
        let title = parsed.embeddedTitle;
        try {
          if (titleBytes.length === 0 && fallbackTitle) {
            title = String(fallbackTitle);
            if (title.includes("\0")) {
              throw new ErrorType("Application title must not contain a NUL character");
            }
            titleBytes = parsed.region === 1 ? encodeUsaTitle(title) : encodeShiftJis(title);
          }
          if (!title && titleBytes.length > 0) {
            title =
              parsed.region === 1
                ? decodeUsaTitle(titleBytes, `${label} title`)
                : (parsed.cardType & 0x0f) === 0x0e
                  ? decodeShiftJis(titleBytes, true)
                  : decodeJapaneseShortTitle(parsed.embeddedTitleBytes, `${label} title`);
          }
        } catch (error) {
          if (error instanceof ErrorType) {
            throw error;
          }
          throw new ErrorType(`${label} has an invalid application title`);
        }
        if (!title) {
          title = UNTITLED_CONTENT_TITLE;
          titleBytes = parsed.region === 1 ? encodeUsaTitle(title) : encodeShiftJis(title);
        }
        if (titleBytes.length >= 0x24) {
          throw new ErrorType("Application title is too long for the save record");
        }
        return { title, titleBytes };
      }

      function applicationPayloadFromEncoded(encoded, common) {
        let execution;
        if (common.header[8] & 0x04) {
          if (encoded.length < 6 || readU16LE(encoded, 0) !== encoded.length - 2) {
            throw new ErrorType("NES dot-code set has an invalid VPK length prefix");
          }
          if (![1, 2].includes(common.region)) {
            throw new ErrorType("Original-region Japanese NES cards are unsupported");
          }
          execution = PROGRAM_EXECUTION_NES;
        } else if (
          encoded.length >= 10 &&
          readU32LE(encoded, 0) === encoded.length - 6 &&
          encoded[4] === 0 &&
          encoded[5] === 0
        ) {
          execution = PROGRAM_EXECUTION_GBA;
        } else {
          if (encoded.length < 6 || readU16LE(encoded, 0) !== encoded.length - 2) {
            throw new ErrorType("Z80 dot-code set has an invalid VPK length prefix");
          }
          execution = PROGRAM_EXECUTION_Z80;
        }

        const { programType, prefixSize: savePrefixSize } = dotcodeSaveLayout(
          execution,
          dotcodeCardHeaderByte(common.header),
          common.region,
        );
        const dotcodePrefixSize = execution === PROGRAM_EXECUTION_GBA ? 6 : 2;
        const payload = encoded.slice(dotcodePrefixSize);
        if (payload.length > 0xffff) {
          throw new ErrorType("Application payload is too large for a saved-program record");
        }
        if (
          [PROGRAM_EXECUTION_Z80, PROGRAM_EXECUTION_NES].includes(execution) &&
          !bytesEqual(payload.subarray(0, 4), asciiBytes("vpk0"))
        ) {
          throw new ErrorType("Dot-code application payload does not contain a vpk0 stream");
        }
        return { programType, savePrefixSize, payload };
      }

      function rawFilesToApplication(rawFiles, fallbackTitle = "") {
        const files = Array.from(rawFiles, normalizeRawFile);
        if (files.length === 0) {
          throw new ErrorType("No RAW strips were supplied");
        }

        const indexedPayloads = new Map();
        let common = null;
        let applicationTitle = null;

        for (const file of files) {
          const decoded = decodeRawDotcodeDetails(file.bytes, file.name);
          const parsed = parseDecodedApplicationStrip(decoded.app, file.name, decoded.cardType);
          if (!common) {
            common = parsed;
            applicationTitle = applicationTitleForSave(parsed, fallbackTitle, file.name);
          } else if (parsed.setId !== common.setId) {
            throw new ErrorType(`${file.name} belongs to a different dot-code application set`);
          }
          if (indexedPayloads.has(parsed.cardIndex)) {
            throw new ErrorType(`duplicate dot-code strip index ${parsed.cardIndex}`);
          }
          indexedPayloads.set(parsed.cardIndex, parsed.app.slice(parsed.payloadOffset));
        }

        const missing = [];
        for (let index = 1; index <= common.cardCount; index += 1) {
          if (!indexedPayloads.has(index)) {
            missing.push(index);
          }
        }
        if (missing.length > 0 || indexedPayloads.size !== common.cardCount) {
          throw new ErrorType(
            `dot-code application set is incomplete; missing strip index/indices: ${missing.join(", ")}`,
          );
        }

        const orderedPayloads = [];
        for (let index = 1; index <= common.cardCount; index += 1) {
          orderedPayloads.push(indexedPayloads.get(index));
        }
        let encoded = concatBytes(...orderedPayloads);
        if (common.encodedSize > encoded.length) {
          throw new ErrorType("Dot-code application set ends before its declared data");
        }
        encoded = encoded.slice(0, common.encodedSize);

        const { programType, savePrefixSize, payload } = applicationPayloadFromEncoded(
          encoded,
          common,
        );
        const payloadFormat = bytesEqual(payload.subarray(0, 4), asciiBytes("vpk0"))
          ? "VPK"
          : "RAW";
        return {
          title: applicationTitle.title,
          titleBytes: applicationTitle.titleBytes,
          region: common.region,
          programType,
          savePrefixSize,
          payload,
          payloadFormat,
          stripCount: files.length,
        };
      }

      function rawExportScanRegion(metadata, applicationRegionHint) {
        // The optional hint preserves known Japanese/Original provenance only
        // while converting an in-memory virtual SAV built from region-0 RAWs.
        if (
          applicationRegionHint !== null &&
          applicationRegionHint !== undefined &&
          !["usa", "japan"].includes(applicationRegionHint)
        ) {
          throw new ErrorType(`Unknown application region: ${applicationRegionHint}`);
        }
        if (metadata.storedRegionCode === JPN_SAVED_REGION_CODE) {
          if (applicationRegionHint === "usa") {
            throw new ErrorType("e-Reader+ application data requires the Japanese region");
          }
          return 2;
        }
        const resolvedRegion = applicationRegionHint ?? metadata.applicationRegion;
        if (resolvedRegion === "japan") {
          return 0;
        }
        return 1;
      }

      function saveToRawDotcodes(saveInput, applicationRegionHint = null) {
        const save = asBytes(saveInput, "save");
        const parsed = saveFormat.parseSave(save);
        const metadata = parsed.metadata;
        if (metadata.titleBytes.length > 32) {
          throw new ErrorType(
            "Saved application title is too long for a generated type-E dot-code",
          );
        }
        if (metadata.extraSize !== 0) {
          throw new ErrorType(
            "Saved application contains extra record data that cannot be represented in RAW strips",
          );
        }
        if (!rawExportPreservesContent(metadata)) {
          throw new ErrorType(
            "This saved application uses a specialized loader variant that has no known downloadable dot-code equivalent",
          );
        }
        const cardHeaderByte = (metadata.programType >>> PROGRAM_TYPE_CARD_HEADER_SHIFT) & 0xff;
        const region = rawExportScanRegion(metadata, applicationRegionHint);
        const dotcodeLayout = dotcodeSaveLayout(metadata.execution, cardHeaderByte, region);

        const payload = parsed.payload;
        let encoded;
        if (metadata.execution === PROGRAM_EXECUTION_GBA) {
          const prefix = new Uint8Array(6);
          writeU32LE(prefix, 0, payload.length);
          encoded = concatBytes(prefix, payload);
        } else {
          const prefix = new Uint8Array(2);
          writeU16LE(prefix, 0, payload.length);
          encoded = concatBytes(prefix, payload);
        }

        const payloadOffset = 12 + 33;
        const capacity = RAW_LONG_BIN_SIZE - payloadOffset;
        const cardCount = Math.max(1, Math.ceil(encoded.length / capacity));
        if (cardCount > 12) {
          throw new ErrorType(
            `saved application needs ${cardCount} RAW strips; the e-Reader supports at most 12`,
          );
        }
        let flags = 0x03;
        if (metadata.execution === PROGRAM_EXECUTION_NES) {
          flags |= 0x04;
        }

        const raws = [];
        const cardType = cardHeaderByte & 0x80 ? 0x1e : 0x0e;
        for (let cardIndex = 1; cardIndex <= cardCount; cardIndex += 1) {
          const app = new Uint8Array(RAW_LONG_BIN_SIZE);
          writeU16LE(app, 0, 0xe000 | (cardHeaderByte << 4) | region);
          const sizeInfo =
            (0x02000000 | (encoded.length << 9) | (cardCount << 5) | (cardIndex << 1)) >>> 0;
          writeU32LE(app, 4, sizeInfo);
          writeU32LE(app, 8, flags);
          app.set(metadata.titleBytes, 12);
          const start = (cardIndex - 1) * capacity;
          app.set(encoded.subarray(start, start + capacity), payloadOffset);
          raws.push(encodeRawDotcode(app, cardType));
        }

        const application = rawFilesToApplication(
          raws.map((bytes, index) => ({ name: `generated RAW ${index + 1}.raw`, bytes })),
          metadata.title || "e-Reader application",
        );
        if (
          (metadata.title && application.title !== metadata.title) ||
          application.programType !== dotcodeLayout.programType ||
          application.savePrefixSize !== dotcodeLayout.prefixSize ||
          !bytesEqual(application.payload, payload)
        ) {
          throw new Error("Generated RAW set changed the saved application");
        }
        return raws;
      }
      return Object.freeze({
        inspectDecodedDotcode,
        inspectRawDotcode,
        selectRawSet,
        rawFilesToApplication,
        saveToRawDotcodes,
      });
    }

    return Object.freeze({ createApplicationCodec });
  },
);
