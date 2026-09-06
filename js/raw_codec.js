(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./binary.js"),
      require("./reed_solomon.js"),
      require("./dotcode_layout.js"),
    );
  } else {
    root.EReaderRawCodec = factory(
      root.EReaderBinary,
      root.EReaderReedSolomon,
      root.EReaderDotcodeLayout,
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (binary, reedSolomon, layout) {
  "use strict";

  const { asBytes, bytesFromHex, asciiBytes, concatBytes, bytesEqual } = binary;

  const RAW_LONG_SIZE = 0x0b60;

  const RAW_SHORT_SIZE = 0x0750;

  const RAW_LONG_BIN_SIZE = 0x081c;

  const RAW_SHORT_BIN_SIZE = 0x051c;

  const RAW_LONG_PHYSICAL_HEADER = bytesFromHex(
    "00 03 00 19 40 10 00 2C 0E 88 ED 82 50 67 FB D1 43 EE 03 C6 C6 2B 2C 93",
  );

  const RAW_SHORT_PHYSICAL_HEADER = bytesFromHex(
    "00 02 00 01 40 10 00 1C 10 6F 40 DA 39 25 8E E0 7B B5 98 B6 5B CF 7F 72",
  );

  function createRawCodec(ErrorType = Error) {
    function xorBytes(data) {
      let result = 0;
      for (const value of asBytes(data)) {
        result ^= value;
      }
      return result;
    }

    function encodeRawDotcode(appInput, physicalCardType = null) {
      const app = asBytes(appInput, "card data");
      let rawSize;
      let physicalHeader;
      let columns;
      let dataEnd;
      let stripHeader;
      if (app.length === RAW_LONG_BIN_SIZE) {
        rawSize = RAW_LONG_SIZE;
        physicalHeader = RAW_LONG_PHYSICAL_HEADER;
        columns = 44;
        dataEnd = 0x0b38;
        stripHeader = bytesFromHex("00 30 01 02 00 01 08 10 00 00 10 12");
      } else if (app.length === RAW_SHORT_BIN_SIZE) {
        rawSize = RAW_SHORT_SIZE;
        physicalHeader = RAW_SHORT_PHYSICAL_HEADER;
        columns = 28;
        dataEnd = 0x0724;
        stripHeader = bytesFromHex("00 30 01 01 00 01 05 10 00 00 10 12");
      } else {
        throw new ErrorType(
          `card data is 0x${app.length.toString(16).toUpperCase()} bytes; expected 0x${RAW_LONG_BIN_SIZE.toString(16).toUpperCase()} or 0x${RAW_SHORT_BIN_SIZE.toString(16).toUpperCase()}`,
        );
      }
      const cardType = physicalCardType === null ? app[1] >>> 4 : physicalCardType;
      if (cardType < 0 || cardType > 0x1f || (cardType & 0x0f) !== app[1] >>> 4) {
        throw new ErrorType("Card type does not match the reduced card header");
      }

      const header = new Uint8Array(0x30);
      header.set(stripHeader);
      header[3] = cardType & 0x10 ? 1 : 2;
      header[0x0d] = app[0];
      header[0x0c] = app[1];
      header[0x0e] = 0x02;
      header[0x0f] = 0;
      header[0x11] = app[2];
      header[0x10] = app[3];
      header[0x12] = 0x10;
      header[0x15] = 0x19;
      header[0x19] = 0x08;
      header.set(asciiBytes("NINTENDO"), 0x1a);
      header.set(bytesFromHex("00 22 00 09"), 0x22);
      header.set(app.subarray(4, 12), 0x26);
      header[0x2e] = xorBytes(app.subarray(0, 12));

      let checksumTotal = 0;
      for (let index = 12; index < app.length; index += 1) {
        checksumTotal += index & 1 ? app[index] : app[index] << 8;
      }
      const dataChecksum = ~checksumTotal & 0xffff;
      header[0x13] = (dataChecksum >>> 8) & 0xff;
      header[0x14] = dataChecksum & 0xff;
      checksumTotal = 0;
      for (let index = 0; index < 0x2f; index += 1) {
        checksumTotal += header[index];
      }
      for (let offset = 12; offset < app.length; offset += 0x30) {
        checksumTotal += xorBytes(app.subarray(offset, offset + 0x30));
      }
      header[0x2f] = ~checksumTotal & 0xff;

      const decoded = concatBytes(header, app.subarray(12));
      if (decoded.length !== columns * 0x30) {
        throw new Error("Generated universal dot-code data has the wrong size");
      }
      const codewords = new Uint8Array(columns * 0x40);
      for (let column = 0; column < columns; column += 1) {
        codewords.set(
          reedSolomon.encodeCodeword(decoded.subarray(column * 0x30, (column + 1) * 0x30)),
          column * 0x40,
        );
      }
      const interleaved = layout.interleave(codewords, 0x40);

      const raw = new Uint8Array(rawSize);
      for (let row = 0; row < rawSize / 0x68; row += 1) {
        const headerOffset = (row % 12) * 2;
        raw.set(physicalHeader.subarray(headerOffset, headerOffset + 2), row * 0x68);
      }
      layout.writeBlockData(raw, interleaved);
      for (let index = dataEnd; index < raw.length; index += 1) {
        raw[index] = index & 0xff;
      }
      const checked = decodeRawDotcodeDetails(raw, "generated RAW");
      if (!bytesEqual(checked.app, app) || checked.cardType !== cardType) {
        throw new Error("Generated RAW did not round-trip");
      }
      return raw;
    }

    function decodeRawDotcodeDetails(rawInput, label = "RAW input") {
      const raw = asBytes(rawInput, "RAW input");
      let expectedPrefix;
      let appSize;
      if (raw.length === RAW_LONG_SIZE) {
        expectedPrefix = bytesFromHex("00 03 00 19 40 10 00 2C");
        appSize = RAW_LONG_BIN_SIZE;
      } else if (raw.length === RAW_SHORT_SIZE) {
        expectedPrefix = bytesFromHex("00 02 00 01 40 10 00 1C");
        appSize = RAW_SHORT_BIN_SIZE;
      } else {
        throw new ErrorType(
          `${label} is 0x${raw.length.toString(16).toUpperCase()} bytes; expected a 0x${RAW_LONG_SIZE.toString(16).toUpperCase()} long or 0x${RAW_SHORT_SIZE.toString(16).toUpperCase()} short RAW strip`,
        );
      }

      const physicalHeader = new Uint8Array(24);
      for (let row = 0; row < 12; row += 1) {
        physicalHeader[row * 2] = raw[row * 0x68];
        physicalHeader[row * 2 + 1] = raw[row * 0x68 + 1];
      }
      if (!bytesEqual(physicalHeader.subarray(0, 8), expectedPrefix)) {
        throw new ErrorType(`${label} has an unsupported or damaged RAW header`);
      }

      const codewordSize = physicalHeader[4];
      const paritySize = physicalHeader[5];
      const columns = physicalHeader[7];
      if (codewordSize !== 0x40 || paritySize !== 0x10) {
        throw new ErrorType(`${label} uses an unsupported RAW error-correction layout`);
      }

      const encodedEnd = Math.floor((codewordSize * columns * 0x68 + 0x65) / 0x66);
      if (encodedEnd > raw.length) {
        throw new ErrorType(`${label} ends before its declared dot-code data`);
      }
      const interleaved = layout.readBlockData(raw, codewordSize * columns);
      const dataSize = codewordSize - paritySize;
      const decoded = layout.deinterleave(interleaved, columns, dataSize);
      const expectedDecodedSize = appSize === RAW_LONG_BIN_SIZE ? 0x840 : 0x540;
      if (decoded.length !== expectedDecodedSize) {
        throw new ErrorType(`${label} decoded to an unexpected card size`);
      }
      if (!bytesEqual(decoded.subarray(0x1a, 0x22), asciiBytes("NINTENDO"))) {
        throw new ErrorType(`${label} is not Nintendo e-Reader dot-code data`);
      }

      const app = new Uint8Array(appSize);
      app[0] = decoded[0x0d];
      app[1] = decoded[0x0c];
      app[2] = decoded[0x11];
      app[3] = decoded[0x10];
      app.set(decoded.subarray(0x26, 0x2e), 4);
      app.set(decoded.subarray(0x30), 12);

      if (xorBytes(app.subarray(0, 12)) !== decoded[0x2e]) {
        throw new ErrorType(`${label} failed its card-header checksum`);
      }

      let checksumTotal = 0;
      for (let index = 12; index < app.length; index += 1) {
        checksumTotal += index & 1 ? app[index] : app[index] << 8;
      }
      const checksumOne = ~checksumTotal & 0xffff;
      if (
        decoded[0x13] !== ((checksumOne >>> 8) & 0xff) ||
        decoded[0x14] !== (checksumOne & 0xff)
      ) {
        throw new ErrorType(`${label} failed its card-data checksum`);
      }

      checksumTotal = 0;
      for (let offset = 0; offset < 0x2f; offset += 1) {
        checksumTotal += decoded[offset];
      }
      for (let offset = 12; offset < app.length; offset += 0x30) {
        checksumTotal += xorBytes(app.subarray(offset, offset + 0x30));
      }
      const checksumTwo = ~checksumTotal & 0xff;
      if (decoded[0x2f] !== checksumTwo) {
        throw new ErrorType(`${label} failed its global checksum`);
      }
      return {
        app,
        scanFormat: decoded[3],
        region: app[0] & 0x0f,
        cardType: ((decoded[3] & 1) << 4) | (app[1] >>> 4),
      };
    }

    function decodeRawDotcode(rawInput, label = "RAW input") {
      return decodeRawDotcodeDetails(rawInput, label).app;
    }
    return Object.freeze({ encodeRawDotcode, decodeRawDotcodeDetails, decodeRawDotcode });
  }

  return Object.freeze({
    createRawCodec,
    RAW_LONG_SIZE,
    RAW_SHORT_SIZE,
    RAW_LONG_BIN_SIZE,
    RAW_SHORT_BIN_SIZE,
  });
});
