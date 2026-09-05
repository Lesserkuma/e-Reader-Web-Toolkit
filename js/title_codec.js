(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./binary.js"));
  } else {
    root.EReaderTitleCodec = factory(root.EReaderBinary);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (binary) {
  "use strict";

  const { asBytes, bytesFromHex } = binary;

  function createTitleCodec(ErrorType = Error) {
    const VIEWER_TITLE_OFFSET = 12;

    const VIEWER_TITLE_SIZE = 20;

    const NATIVE_TITLE_OFFSET = 12;

    const NATIVE_TITLE_SIZE = 33;

    const USA_TITLE_GLYPHS = Object.freeze({
      0x7f: "é",
      0x9b: "♂",
      0x9c: "♀",
    });

    const USA_TITLE_BYTES = Object.freeze(
      Object.fromEntries(
        Object.entries(USA_TITLE_GLYPHS).map(([value, character]) => [character, Number(value)]),
      ),
    );

    const SHARED_NATIVE_TYPE_FALLBACK_TITLES = Object.freeze({
      0x06: "Recognize",
    });

    const JPN_NATIVE_TYPE_FALLBACK_TITLES = Object.freeze({
      0x08: "e Game Zero: Block Break",
      0x0a: "e Game Zero: Action",
      0x0c: "e Game Zero: Melody Box",
    });

    const USA_NATIVE_TYPE_FALLBACK_TITLES = Object.freeze({
      0x08: "Construction: Escape",
      0x0a: "Construction: Action",
      0x0c: "Construction: Melody Box",
    });

    const JAPANESE_SHORT_TITLE_SHIFT_JIS = bytesFromHex(
      "81 40 81 40 82 4F 82 50 82 51 82 52 82 53 82 54 82 55 82 56 82 57 82 58 82 9F 82 A0 82 A1 82 A2 " +
        "82 A3 82 A4 82 A5 82 A6 82 A7 82 A8 82 A9 82 AA 82 AB 82 AC 82 AD 82 AE 82 AF 82 B0 82 B1 82 B2 " +
        "82 B3 82 B4 82 B5 82 B6 82 B7 82 B8 82 B9 82 BA 82 BB 82 BC 82 BD 82 BE 82 BF 82 C0 82 C1 82 C2 " +
        "82 C3 82 C4 82 C5 82 C6 82 C7 82 C8 82 C9 82 CA 82 CB 82 CC 82 CD 82 CE 82 CF 82 D0 82 D1 82 D2 " +
        "82 D3 82 D4 82 D5 83 77 82 D7 82 D8 82 D9 82 DA 82 DB 82 DC 82 DD 82 DE 82 DF 82 E0 82 E1 82 E2 " +
        "82 E3 82 E4 82 E5 82 E6 82 E7 82 E8 82 E9 82 EA 82 EB 82 EC 82 ED 82 F0 82 F1 83 40 83 41 83 42 " +
        "83 43 83 44 83 45 83 46 83 47 83 48 83 49 83 4A 83 4B 83 4C 83 4D 83 4E 83 4F 83 50 83 51 83 52 " +
        "83 53 83 54 83 55 83 56 83 57 83 58 83 59 83 5A 83 5B 83 5C 83 5D 83 5E 83 5F 83 60 83 61 83 62 " +
        "83 63 83 64 83 65 83 66 83 67 83 68 83 69 83 6A 83 6B 83 6C 83 6D 83 6E 83 6F 83 70 83 71 83 72 " +
        "83 73 83 74 83 75 83 76 83 77 83 78 83 79 83 7A 83 7B 83 7C 83 7D 83 7E 83 80 83 81 83 82 83 83 " +
        "83 84 83 85 83 86 83 87 83 88 83 89 83 8A 83 8B 83 8C 83 8D 83 8E 83 8F 83 93 83 94 83 95 83 96 " +
        "81 5B 81 89 81 8A 81 41 81 42 81 49 81 68 81 93 81 95 81 60 81 48 81 5E 81 7B 81 7C 81 46 81 44 " +
        "81 4C 82 60 82 61 82 62 82 63 82 64 82 65 82 66 82 67 82 68 82 69 82 6A 82 6B 82 6C 82 6D 82 6E " +
        "82 6F 82 70 82 71 82 72 82 73 82 74 82 75 82 76 82 77 82 78 82 79 81 40 81 40 81 40 81 40 81 40 " +
        "81 40 81 40 81 40 81 40 81 40 81 40 82 81 82 82 82 83 82 84 82 85 82 86 82 87 82 88 82 89 82 8A " +
        "82 8B 82 8C 82 8D 82 8E 82 8F 82 90 82 91 82 92 82 93 82 94 82 95 82 96 82 97 82 98 82 99 82 9A",
    );

    function firstNull(bytes) {
      const offset = bytes.indexOf(0);
      return offset === -1 ? bytes : bytes.subarray(0, offset);
    }

    function decodeAscii(bytes) {
      return String.fromCharCode(...bytes);
    }

    function shiftJisDecoder(fatal) {
      try {
        return new TextDecoder("shift_jis", { fatal });
      } catch (error) {
        if (error instanceof RangeError) {
          throw new ErrorType("Shift-JIS decoding is not available in this browser");
        }
        throw error;
      }
    }

    function decodeShiftJis(bytes, fatal) {
      return shiftJisDecoder(fatal).decode(bytes);
    }

    function japaneseShortTitleToShiftJis(bytesInput, label = "title") {
      const bytes = firstNull(asBytes(bytesInput, label));
      const encoded = new Uint8Array(bytes.length * 2);
      for (let index = 0; index < bytes.length; index += 1) {
        const offset = bytes[index] * 2;
        encoded.set(JAPANESE_SHORT_TITLE_SHIFT_JIS.subarray(offset, offset + 2), index * 2);
      }
      return encoded;
    }

    function decodeJapaneseShortTitle(bytesInput, label = "title") {
      return decodeShiftJis(japaneseShortTitleToShiftJis(bytesInput, label), true);
    }

    function decodeUsaTitle(bytesInput, label = "USA e-Reader title") {
      const bytes = firstNull(asBytes(bytesInput, label));
      let title = "";
      for (const value of bytes) {
        if (value >= 0x20 && value < 0x7f) {
          title += String.fromCharCode(value);
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(USA_TITLE_GLYPHS, value)) {
          throw new ErrorType(
            `${label} contains unsupported e-Reader character 0x${value.toString(16).toUpperCase().padStart(2, "0")}`,
          );
        }
        title += USA_TITLE_GLYPHS[value];
      }
      return title;
    }

    function encodeUsaTitle(value, label = "USA e-Reader title") {
      const title = String(value);
      const encoded = [];
      for (const character of title) {
        const codePoint = character.codePointAt(0);
        if (codePoint >= 0x20 && codePoint < 0x7f) {
          encoded.push(codePoint);
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(USA_TITLE_BYTES, character)) {
          throw new ErrorType(
            `${label} contains a character that cannot be encoded for the English version`,
          );
        }
        encoded.push(USA_TITLE_BYTES[character]);
      }
      return Uint8Array.from(encoded);
    }

    function isPrintableTitle(title) {
      return (
        title.length > 0 &&
        [...title].every((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint >= 0x20 && codePoint !== 0x7f;
        })
      );
    }

    function decodeExtendedTitleField(bytesInput, region, label) {
      const titleBytes = firstNull(asBytes(bytesInput, label));
      if (titleBytes.length === 0) {
        return null;
      }
      if (region === 1) {
        try {
          const title = decodeUsaTitle(titleBytes, label);
          const titleEncoding = titleBytes.every((value) => value >= 0x20 && value < 0x7f)
            ? "ASCII"
            : "e-Reader USA 1-byte";
          return { title, titleEncoding, saveTitleBytes: titleBytes.slice() };
        } catch (error) {
          if (!(error instanceof ErrorType)) {
            throw error;
          }
          return null;
        }
      }

      try {
        const title = decodeShiftJis(titleBytes, true);
        if (isPrintableTitle(title)) {
          return { title, titleEncoding: "Shift-JIS", saveTitleBytes: titleBytes.slice() };
        }
      } catch (error) {
        if (error instanceof ErrorType) {
          throw error;
        }
      }

      try {
        const title = new TextDecoder("utf-8", { fatal: true }).decode(titleBytes);
        if (!isPrintableTitle(title)) {
          return null;
        }
        return {
          title,
          titleEncoding: "UTF-8",
          saveTitleBytes: encodeShiftJis(title, label),
        };
      } catch (error) {
        if (error instanceof ErrorType || error instanceof RangeError) {
          throw error;
        }
        return null;
      }
    }

    function decodeDirectJapaneseViewerTitle(app) {
      // Direct-title records declare the alternate field layout in their header.
      // This keeps coincidental byte pairs in compact names from looking like
      // valid Shift-JIS titles.
      if (app[5] !== 0x20 || app[6] !== 0x01 || app.subarray(8, 12).some((value) => value !== 0)) {
        return null;
      }
      const titleBytes = firstNull(
        app.subarray(VIEWER_TITLE_OFFSET, VIEWER_TITLE_OFFSET + VIEWER_TITLE_SIZE),
      );
      if (titleBytes.length === 0 || titleBytes.length % 2 !== 0) {
        return null;
      }
      for (let offset = 0; offset < titleBytes.length; offset += 2) {
        const lead = titleBytes[offset];
        const trail = titleBytes[offset + 1];
        if (!((lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc))) {
          return null;
        }
        if (trail < 0x40 || trail > 0xfc || trail === 0x7f) {
          return null;
        }
      }
      try {
        const title = decodeShiftJis(titleBytes, true);
        return [...title].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint < 0x20 || codePoint === 0x7f;
        })
          ? null
          : title;
      } catch (error) {
        if (error instanceof RangeError) {
          throw error;
        }
        return null;
      }
    }

    function decodeNativeTitle(decoded) {
      if (decoded.cardType !== 0x0f && decoded.cardType !== 0x1f) {
        return null;
      }
      const titleField = decoded.app.subarray(
        NATIVE_TITLE_OFFSET,
        NATIVE_TITLE_OFFSET + NATIVE_TITLE_SIZE,
      );
      const terminator = titleField.indexOf(0);
      if (terminator >= 0 && titleField.subarray(terminator).some((value) => value !== 0)) {
        return null;
      }
      const decodedTitle = decodeExtendedTitleField(
        titleField,
        decoded.region,
        "native game title",
      );
      return decodedTitle === null
        ? null
        : { title: decodedTitle.title, titleEncoding: decodedTitle.titleEncoding };
    }

    function nativeTypeFallbackTitle(region, cardType) {
      const family = cardType & 0xfe;
      if (Object.prototype.hasOwnProperty.call(SHARED_NATIVE_TYPE_FALLBACK_TITLES, family)) {
        return SHARED_NATIVE_TYPE_FALLBACK_TITLES[family];
      }
      const regionalTitles =
        region === 1 ? USA_NATIVE_TYPE_FALLBACK_TITLES : JPN_NATIVE_TYPE_FALLBACK_TITLES;
      return regionalTitles[family];
    }

    let compactJapaneseTitleEncodings = null;

    let completeShiftJisEncodings = null;

    function compactJapaneseTitleEncodingMap() {
      if (compactJapaneseTitleEncodings) {
        return compactJapaneseTitleEncodings;
      }
      const decoder = shiftJisDecoder(true);
      const encodings = new Map();
      for (let compact = 1; compact <= 0xff; compact += 1) {
        const pair = JAPANESE_SHORT_TITLE_SHIFT_JIS.subarray(compact * 2, compact * 2 + 2);
        const character = decoder.decode(pair);
        if (!encodings.has(character)) {
          encodings.set(character, (pair[0] << 8) | pair[1]);
        }
      }
      compactJapaneseTitleEncodings = encodings;
      return encodings;
    }

    function completeShiftJisEncodingMap() {
      if (completeShiftJisEncodings) {
        return completeShiftJisEncodings;
      }
      const decoder = shiftJisDecoder(true);
      const encodings = new Map(compactJapaneseTitleEncodingMap());
      const remember = (bytes, encoded) => {
        try {
          const character = decoder.decode(bytes);
          if ([...character].length === 1 && !encodings.has(character)) {
            encodings.set(character, encoded);
          }
        } catch (error) {
          if (!(error instanceof TypeError)) {
            throw error;
          }
        }
      };

      for (let value = 0x80; value <= 0xff; value += 1) {
        remember(Uint8Array.of(value), value);
      }
      for (const [leadStart, leadEnd] of [
        [0x81, 0x9f],
        [0xe0, 0xfc],
      ]) {
        for (let lead = leadStart; lead <= leadEnd; lead += 1) {
          for (let trail = 0x40; trail <= 0xfc; trail += 1) {
            if (trail !== 0x7f) {
              remember(Uint8Array.of(lead, trail), (lead << 8) | trail);
            }
          }
        }
      }

      // The Encoding Standard defines these encoder aliases even though the
      // corresponding single bytes decode as ASCII characters.
      encodings.set("¥", 0x5c);
      encodings.set("‾", 0x7e);
      if (encodings.has("－")) {
        encodings.set("−", encodings.get("－"));
      }
      completeShiftJisEncodings = encodings;
      return encodings;
    }

    function encodeShiftJis(value, label = "application title") {
      const text = String(value);
      if (text.includes("\0")) {
        throw new ErrorType(`${label} must not contain a NUL character`);
      }
      const encoded = [];
      const compactEncodings = compactJapaneseTitleEncodingMap();
      for (const character of text) {
        const codePoint = character.codePointAt(0);
        if (codePoint <= 0x7f) {
          encoded.push(codePoint);
          continue;
        }
        const valueFromMap =
          compactEncodings.get(character) ?? completeShiftJisEncodingMap().get(character);
        if (valueFromMap === undefined) {
          throw new ErrorType(
            `${label} contains a character that cannot be encoded for the Japanese version`,
          );
        }
        if (valueFromMap <= 0xff) {
          encoded.push(valueFromMap);
        } else {
          encoded.push(valueFromMap >>> 8, valueFromMap & 0xff);
        }
      }
      return Uint8Array.from(encoded);
    }

    function japaneseApplicationTitle(value) {
      let title = "";
      for (const character of String(value)) {
        const codePoint = character.codePointAt(0);
        if (codePoint === 0x20) {
          title += "\u3000";
        } else if (codePoint >= 0x21 && codePoint <= 0x7e) {
          title += String.fromCodePoint(codePoint + 0xfee0);
        } else {
          title += character;
        }
      }
      return title;
    }
    return Object.freeze({
      firstNull,
      decodeAscii,
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
      japaneseApplicationTitle,
    });
  }

  return Object.freeze({ createTitleCodec });
});
