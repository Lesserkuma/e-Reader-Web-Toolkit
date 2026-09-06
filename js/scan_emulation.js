(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./binary.js"));
  } else {
    root.EReaderScanEmulation = factory(root.EReaderBinary);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (binary) {
  "use strict";

  const ROM_SIZE = 0x800000;
  const RAW_OFFSET = 0x740000;
  const SLOT_SIZE = 0x2000;
  const MAX_CARDS = (ROM_SIZE - RAW_OFFSET) / SLOT_SIZE;
  const PROFILES = [
    {
      start: 0x9038, end: 0x9a20,
      sha256: "560741845220fec45aa52dc89fb25f5724cd33bdb63ff34bd38fb6a8a714ed51",
      continuation: 0x080091e1, format: 0x02029416,
      payload: 0x02028b78, cursor: 0x02032d10,
    },
    {
      start: 0x90ac, end: 0x9b40,
      sha256: "6ea42c56c5860d80936e1c43d12f580df02f707372ec5e9cd0222c441b9cd26a",
      continuation: 0x08009255, format: 0x02031922,
      payload: 0x02031084, cursor: 0x0202f8a0,
    },
  ];

  // Reader at +0x00, interrupt-preserving wrapper at +0xA0.
  const TEMPLATE = binary.bytesFromHex(
    "70 B5 46 46 40 B4 83 B0 18 48 01 68 2B 22 91 42 " +
    "00 D3 00 21 4B 1C 03 60 15 4A 51 43 15 48 41 18 " +
    "08 68 15 4A 10 80 04 31 48 68 00 90 88 68 01 90 " +
    "08 68 02 90 11 48 0C 22 0B 68 03 60 04 31 04 30 " +
    "04 3A F9 D1 0E 48 81 22 12 01 0B 68 03 60 04 31 " +
    "04 30 04 3A F9 D1 04 98 0B 49 08 80 05 98 0B 49 " +
    "08 80 02 AC 6D 46 0A 35 06 4B 18 47 10 2D 03 02 " +
    "00 20 00 00 00 10 74 08 16 94 02 02 6C 65 02 02 " +
    "78 8B 02 02 E1 91 00 08 00 02 00 04 08 02 00 04 " +
    "FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF " +
    "70 B5 09 49 0D 88 00 22 0A 80 06 49 0C 88 0A 80 " +
    "FF F7 A6 FF 03 49 0C 80 03 49 0D 80 70 BC 02 BC " +
    "08 47 C0 46 00 02 00 04 08 02 00 04",
  );

  function createScanEmulation(ErrorType, rawCodec) {
    async function buildRom(romInput, rawFiles, rawOffset = RAW_OFFSET) {
      const rom = binary.asBytes(romInput, "ROM");
      if (rom.length !== ROM_SIZE) throw new ErrorType("Scan emulation requires an 8 MiB ROM.");
      if (rawOffset !== RAW_OFFSET && rawOffset !== RAW_OFFSET + SLOT_SIZE) {
        throw new ErrorType("Invalid additional scan storage offset.");
      }
      const files = Array.from(rawFiles);
      const capacity = (ROM_SIZE - rawOffset) / SLOT_SIZE;
      if (files.length < 1 || files.length > capacity) {
        throw new ErrorType(`Add between 1 and ${capacity} additional dot-code strips.`);
      }
      const matches = [];
      for (const profile of PROFILES) {
        if (await binary.sha256(rom.subarray(profile.start, profile.end)) === profile.sha256) {
          matches.push(profile);
        }
      }
      if (matches.length !== 1) {
        throw new ErrorType("Unsupported or modified firmware scan path.");
      }
      const profile = matches[0];
      const usedEnd = rawOffset + files.length * SLOT_SIZE;
      if (!rom.subarray(rawOffset, usedEnd).every((byte) => byte === 0xff)) {
        throw new ErrorType("Additional scan storage overlaps existing ROM content.");
      }
      const cards = files.map((file, index) => {
        const name = file.name || `Additional scan ${index + 1}`;
        const raw = binary.asBytes(file.bytes, name);
        const decoded = rawCodec.decodeRawDotcodeDetails(raw, name);
        const record = new Uint8Array(0x820);
        binary.writeU32LE(record, 0, decoded.scanFormat);
        record.set(decoded.app, 4);
        return { raw, record };
      });
      const stub = TEMPLATE.slice();
      stub[0x0c] = cards.length;
      binary.writeU32LE(stub, 0x6c, profile.cursor);
      binary.writeU32LE(stub, 0x74, 0x08000000 + rawOffset + 0x1000);
      binary.writeU32LE(stub, 0x78, profile.format);
      binary.writeU32LE(stub, 0x80, profile.payload);
      binary.writeU32LE(stub, 0x84, profile.continuation);

      const output = binary.cloneBytes(rom);
      output.set(stub, rawOffset + 0xc00);
      for (const [index, { raw, record }] of cards.entries()) {
        const offset = rawOffset + index * SLOT_SIZE;
        output.set(raw, offset);
        output.set(record, offset + 0x1000);
      }
      output.set(binary.bytesFromHex("00 4B 18 47"), profile.start);
      binary.writeU32LE(output, profile.start + 4, (0x08000000 + rawOffset + 0xca0) | 1);
      return output;
    }
    return Object.freeze({ buildRom });
  }

  return Object.freeze({ createScanEmulation, RAW_OFFSET, SLOT_SIZE, MAX_CARDS });
});
