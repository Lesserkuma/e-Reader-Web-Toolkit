(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./binary.js"),
      require("./card_constants.js"),
      require("./title_codec.js"),
      require("./raw_codec.js"),
      require("./save_format.js"),
      require("./application_codec.js"),
      require("./scan_emulation.js"),
    );
  } else {
    root.EReaderPatcher = factory(
      root.EReaderBinary,
      root.EReaderCardConstants,
      root.EReaderTitleCodec,
      root.EReaderRawCodec,
      root.EReaderSaveFormat,
      root.EReaderApplicationCodec,
      root.EReaderScanEmulation,
    );
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function (binary, cardConstants, titleModule, rawModule, saveModule, applicationModule, scanModule) {
    "use strict";

    class PatcherError extends Error {
      constructor(message) {
        super(message);
        this.name = "PatcherError";
      }
    }

    const titles = titleModule.createTitleCodec(PatcherError);
    const saveFormat = saveModule.createSaveFormat(PatcherError, titles);
    const rawCodec = rawModule.createRawCodec(PatcherError);
    const scanEmulation = scanModule.createScanEmulation(PatcherError, rawCodec);
    const application = applicationModule.createApplicationCodec(
      PatcherError,
      titles,
      saveFormat,
      rawCodec,
    );

    const {
      asBytes,
      bytesFromHex,
      asciiBytes,
      concatBytes,
      bytesEqual,
      bytesToHex,
      writeU16LE,
      crc32,
    } = binary;
    const {
      SAVE_SIZE,
      CALIBRATION_SECTOR_SIZE,
      CALIBRATION_PRIMARY_OFFSET,
      CALIBRATION_SECONDARY_OFFSET,
      SAVED_RECORD_START,
      SAVED_RECORD_PRIMARY_SIZE,
      SAVED_RECORD_MAX_SIZE,
      PROGRAM_TYPE_DISPATCH_MASK,
      PROGRAM_TYPE_CARD_HEADER_SHIFT,
      PROGRAM_TYPE_STORED_REGION_SHIFT,
      PROGRAM_TYPE_STORED_REGION_MASK,
      JPN_SAVED_REGION_CODE,
      PROGRAM_EXECUTION_Z80,
      PROGRAM_EXECUTION_GBA,
    } = cardConstants;
    const { firstNull, decodeAscii, japaneseShortTitleToShiftJis, decodeJapaneseShortTitle } =
      titles;
    const {
      savedRecordBytes,
      dotcodeSaveLayout,
      validateSave,
      extractSaveCalibration,
      applySaveCalibration,
      extractSavePayload,
      buildVirtualSave,
      setSaveApplicationTitle,
    } = saveFormat;
    const {
      inspectDecodedDotcode,
      inspectRawDotcode,
      selectRawSet,
      rawFilesToApplication,
      saveToRawDotcodes,
    } = application;
    const { encodeRawDotcode, decodeRawDotcodeDetails, decodeRawDotcode } = rawCodec;
    const { RAW_LONG_SIZE, RAW_SHORT_SIZE, RAW_LONG_BIN_SIZE, RAW_SHORT_BIN_SIZE } = rawModule;

    function inspectScanCard(raw, label) {
      const decoded = decodeRawDotcodeDetails(raw, label);
      try {
        return inspectDecodedDotcode(decoded, label);
      } catch (error) {
        if (!(error instanceof PatcherError)) throw error;
        return {
          region: decoded.region,
          cardType: decoded.cardType,
          embeddedTitle: `Type 0x${decoded.cardType.toString(16).toUpperCase().padStart(2, "0")}`,
          titleEncoding: "none",
          cardIndex: 1,
          cardCount: 1,
        };
      }
    }

    async function sha256(data) {
      try {
        return await binary.sha256(data);
      } catch (error) {
        if (error instanceof binary.BinaryError) throw new PatcherError(error.message);
        throw error;
      }
    }

    const ROM_SIZE = 0x800000;

    const SAVE_BANK_SIZE = 0x10000;

    const SAV_BANK1_IMPORT_END = 0x1ff80;

    const EXPECTED_USA_ROM_SHA256 =
      "72bf37f887e896add1342bf95a7cfe3494a689199f878e5e1aa3072639b1b948";

    const EXPECTED_JPN_ROM_SHA256 =
      "db0a82027ac17da69c9651aed8f3be9c4814ea30ca04b6ccba2e7895bd7dde6d";

    const ROM_BANK1_OFFSET = 0x720000;

    const ROM_BANK0_OFFSET = 0x730000;

    const ROM_SAVE_IMAGE_END = ROM_BANK0_OFFSET + SAVE_BANK_SIZE;

    const NATIVE_CARD_DATA_OFFSET = ROM_SAVE_IMAGE_END;

    const USA_LEGAL_SPLASH_BYPASS_OFFSET = 0x006108;

    const JPN_LEGAL_SPLASH_BYPASS_OFFSET = 0x00614e;

    const USA_BOOT_BYPASS_OFFSET = 0x0061a4;

    const JPN_BOOT_BYPASS_OFFSET = 0x0061f0;

    const USA_RETURN_RELAUNCH_OFFSET = 0x006364;

    const JPN_RETURN_RELAUNCH_OFFSET = 0x0063b0;

    const USA_ERASE_MENU_BYPASS_OFFSET = 0x029570;

    const JPN_ERASE_MENU_BYPASS_OFFSET = 0x02a7da;

    const USA_READ_FLASH_OFFSET = 0x043c74;

    const JPN_READ_FLASH_OFFSET = 0x053e34;

    const USA_SAVE_TYPE_MARKER_OFFSET = 0x3b63a0;

    const JPN_SAVE_TYPE_MARKER_OFFSET = 0x349fb0;

    const READ_STUB_OFFSET = 0x71ffd0;

    const READ_STUB_ADDRESS = 0x08000000 + READ_STUB_OFFSET;

    const ROM_TITLE_OFFSET = 0xa0;

    const ROM_TITLE_SIZE = 12;

    const STANDALONE_ROM_TITLE = asciiBytes("E-READER SA\0");

    const GAME_CODE_OFFSET = 0xac;

    const HEADER_CHECKSUM_OFFSET = 0xbd;

    const NATIVE_CARD_DATA_END = NATIVE_CARD_DATA_OFFSET + RAW_LONG_BIN_SIZE + 12;

    function binaryPatch(offset, expected, replacement, description) {
      return Object.freeze({
        offset,
        expected: typeof expected === "string" ? bytesFromHex(expected) : asBytes(expected),
        replacement:
          typeof replacement === "string" ? bytesFromHex(replacement) : asBytes(replacement),
        description,
      });
    }

    function snapshotPatch(patch) {
      return Object.freeze({
        ...patch,
        expected: patch.expected.slice(),
        replacement: patch.replacement.slice(),
      });
    }

    function snapshotPatchList(patches) {
      return Object.freeze(patches.map(snapshotPatch));
    }

    function snapshotRomProfile(profile) {
      return Object.freeze({
        ...profile,
        title: profile.title.slice(),
        gameCode: profile.gameCode.slice(),
        privateGameCode: profile.privateGameCode.slice(),
        patches: snapshotPatchList(profile.patches),
      });
    }

    const READ_FLASH_REPLACEMENT = concatBytes(
      bytesFromHex("10 B4 01 4C 20 47 C0 46"),
      new Uint8Array([
        (READ_STUB_ADDRESS | 1) & 0xff,
        ((READ_STUB_ADDRESS | 1) >>> 8) & 0xff,
        ((READ_STUB_ADDRESS | 1) >>> 16) & 0xff,
        ((READ_STUB_ADDRESS | 1) >>> 24) & 0xff,
      ]),
    );

    const USA_PATCHES = Object.freeze([
      binaryPatch(
        0x0000ac,
        asciiBytes("PSAE"),
        asciiBytes("ERDE"),
        "use the standalone e-Reader game code",
      ),
      binaryPatch(
        USA_LEGAL_SPLASH_BYPASS_OFFSET,
        "33 F0 6C F9",
        "00 46 00 46",
        "skip the standalone Nintendo/Creatures/HAL legal splash",
      ),
      binaryPatch(
        USA_BOOT_BYPASS_OFFSET,
        "0A F0 3A F9",
        "82 E0 00 46",
        "skip title/menu and select saved-application state 9",
      ),
      binaryPatch(
        USA_ERASE_MENU_BYPASS_OFFSET,
        "06 D1",
        "06 E0",
        "always skip the L+R saved-data erase prompt",
      ),
      binaryPatch(
        USA_RETURN_RELAUNCH_OFFSET,
        "91 E0",
        "A2 E7",
        "relaunch the embedded application if it returns",
      ),
      binaryPatch(
        USA_READ_FLASH_OFFSET,
        "F0 B5 A0 B0 0D 1C 16 1C 1F 1C 03 04",
        READ_FLASH_REPLACEMENT,
        "redirect FLASH1M ReadFlash to the ROM-backed Thumb stub",
      ),
      binaryPatch(
        0x0439fc,
        "00 06 00 0E",
        "00 20 70 47",
        "make FLASH1M bank switching a hardware-free no-op",
      ),
      binaryPatch(
        0x043a20,
        "30 B5 91 B0 68 46 00 F0",
        "00 48 70 47 C2 09 00 00",
        "identify a virtual Macronix FLASH1M device without cartridge access",
      ),
      binaryPatch(0x043d40, "30 B5 C0 B0", "00 20 70 47", "neutralize FLASH1M sector verification"),
      binaryPatch(0x043dd8, "70 B5 C0 B0", "00 20 70 47", "neutralize FLASH1M ranged verification"),
      binaryPatch(0x043e70, "70 B5 0D 1C", "00 20 70 47", "neutralize FLASH1M program-and-verify"),
      binaryPatch(
        0x043eb4,
        "F0 B5 0D 1C",
        "00 20 70 47",
        "neutralize FLASH1M ranged program-and-verify",
      ),
      binaryPatch(0x043f9c, "F0 B5 4F 46", "00 20 70 47", "neutralize FLASH1M write polling"),
      binaryPatch(0x04403c, "70 B5 90 B0", "00 20 70 47", "neutralize FLASH1M chip erase"),
      binaryPatch(0x0440b0, "F0 B5 90 B0", "00 20 70 47", "neutralize FLASH1M sector erase"),
      binaryPatch(0x044180, "F0 B5 90 B0", "00 20 70 47", "neutralize FLASH1M byte programming"),
      binaryPatch(
        0x044214,
        "10 B5 0A 4C",
        "00 20 70 47",
        "neutralize FLASH1M low-level byte programming",
      ),
      binaryPatch(0x04424c, "F0 B5 90 B0", "00 20 70 47", "neutralize FLASH1M sector programming"),
      binaryPatch(
        USA_SAVE_TYPE_MARKER_OFFSET,
        asciiBytes("FLASH1M_V103"),
        asciiBytes("ROMONLY_V103"),
        "remove the emulator/flash-cart FLASH1M save-type marker",
      ),
    ]);

    const USA_FLASH_PATCH_OFFSETS = new Set([
      USA_READ_FLASH_OFFSET,
      0x0439fc,
      0x043a20,
      0x043d40,
      0x043dd8,
      0x043e70,
      0x043eb4,
      0x043f9c,
      0x04403c,
      0x0440b0,
      0x044180,
      0x044214,
      0x04424c,
    ]);

    const USA_FLASH_PATCHES = USA_PATCHES.filter((patch) =>
      USA_FLASH_PATCH_OFFSETS.has(patch.offset),
    );

    const JPN_FLASH_OFFSET_DELTA = JPN_READ_FLASH_OFFSET - USA_READ_FLASH_OFFSET;

    const JPN_FLASH_PATCHES = USA_FLASH_PATCHES.map((patch) =>
      binaryPatch(
        patch.offset + JPN_FLASH_OFFSET_DELTA,
        patch.expected,
        patch.replacement,
        patch.description,
      ),
    );

    const JPN_PATCHES = Object.freeze([
      binaryPatch(
        0x0000ac,
        asciiBytes("PSAJ"),
        asciiBytes("ERDJ"),
        "use the Japanese standalone e-Reader game code",
      ),
      binaryPatch(
        JPN_LEGAL_SPLASH_BYPASS_OFFSET,
        "34 F0 CF F9",
        "00 46 00 46",
        "skip the Japanese Nintendo/Creatures/HAL legal splash",
      ),
      binaryPatch(
        JPN_BOOT_BYPASS_OFFSET,
        "0A F0 7E FB",
        "82 E0 00 46",
        "skip Japanese title/menu and select saved-application state 9",
      ),
      binaryPatch(
        JPN_ERASE_MENU_BYPASS_OFFSET,
        "06 D1",
        "06 E0",
        "always skip the L+R saved-data erase prompt",
      ),
      binaryPatch(
        JPN_RETURN_RELAUNCH_OFFSET,
        "A4 E0",
        "A2 E7",
        "relaunch the embedded Japanese application if it returns",
      ),
      ...JPN_FLASH_PATCHES,
      binaryPatch(
        JPN_SAVE_TYPE_MARKER_OFFSET,
        asciiBytes("FLASH1M_V103"),
        asciiBytes("ROMONLY_V103"),
        "remove the Japanese emulator/flash-cart FLASH1M save-type marker",
      ),
    ]);

    const USA_ROM_PROFILE = Object.freeze({
      key: "usa",
      name: "e-Reader (USA)",
      sha256: EXPECTED_USA_ROM_SHA256,
      title: asciiBytes("CARDE READER"),
      gameCode: asciiBytes("PSAE"),
      privateGameCode: asciiBytes("ERDE"),
      saveMarkerOffset: USA_SAVE_TYPE_MARKER_OFFSET,
      patches: USA_PATCHES,
    });

    const JPN_ROM_PROFILE = Object.freeze({
      key: "japan",
      name: "Card e-Reader+ (Japan)",
      sha256: EXPECTED_JPN_ROM_SHA256,
      title: asciiBytes("CARDEREADER+"),
      gameCode: asciiBytes("PSAJ"),
      privateGameCode: asciiBytes("ERDJ"),
      saveMarkerOffset: JPN_SAVE_TYPE_MARKER_OFFSET,
      patches: JPN_PATCHES,
    });

    const ROM_PROFILES_BY_SHA256 = new Map([
      [USA_ROM_PROFILE.sha256, USA_ROM_PROFILE],
      [JPN_ROM_PROFILE.sha256, JPN_ROM_PROFILE],
    ]);

    const PUBLIC_ROM_PROFILES = Object.freeze({
      usa: snapshotRomProfile(USA_ROM_PROFILE),
      japan: snapshotRomProfile(JPN_ROM_PROFILE),
    });

    const PUBLIC_PATCHES = Object.freeze({
      usa: snapshotPatchList(USA_PATCHES),
      japan: snapshotPatchList(JPN_PATCHES),
    });

    const USA_NATIVE_CARD_PROFILE = Object.freeze({
      bootOffset: USA_BOOT_BYPASS_OFFSET,
      bootExpected: bytesFromHex("0A F0 3A F9"),
      mainMenuOffset: 0x61d0,
      mainMenuExpected: bytesFromHex("06 48 00 25"),
      viewerExitOffset: 0x9f9c,
      viewerExitExpected: bytesFromHex("07 20"),
      returnPatchOffset: USA_RETURN_RELAUNCH_OFFSET,
      stubOffset: 0x2d6304,
      scanResetAddresses: [0x0800227c, 0x08015fe0, 0x08000ebc],
      scanOverlayRestoreAddress: 0x080099f0,
      scanPrepareAddress: 0x0800547c,
      scanSetupAddress: 0x080099c8,
      parserAddress: 0x08009294,
      formatAddress: 0x02029416,
      headerAddress: 0x020294a0,
      payloadAddress: 0x02028b78,
      validationHeaderAddress: 0x0202656c,
      nativeContextAddress: 0x02029434,
      outerStateAddress: 0x0202941c,
      frameDispatchAddress: 0x08006491,
    });

    const JPN_NATIVE_CARD_PROFILE = Object.freeze({
      bootOffset: JPN_BOOT_BYPASS_OFFSET,
      bootExpected: bytesFromHex("0A F0 7E FB"),
      mainMenuOffset: 0x621c,
      mainMenuExpected: bytesFromHex("06 48 00 25"),
      viewerExitOffset: 0xa0cc,
      viewerExitExpected: bytesFromHex("07 20"),
      returnPatchOffset: JPN_RETURN_RELAUNCH_OFFSET,
      stubOffset: 0x28d23c,
      scanResetAddresses: [0x080022c0, 0x080169a8, 0x08000efc],
      scanOverlayRestoreAddress: 0x08009b10,
      scanPrepareAddress: 0x080054cc,
      scanSetupAddress: 0x08009a9c,
      parserAddress: 0x0800932c,
      formatAddress: 0x02031922,
      headerAddress: 0x020319ac,
      payloadAddress: 0x02031084,
      validationHeaderAddress: 0x0202656c,
      nativeContextAddress: 0x02031940,
      outerStateAddress: 0x02031928,
      frameDispatchAddress: 0x08006503,
    });

    const NATIVE_CARD_PROFILES = Object.freeze({
      usa: USA_NATIVE_CARD_PROFILE,
      japan: JPN_NATIVE_CARD_PROFILE,
    });

    const READ_STUB = bytesFromHex(
      "1F 24 20 40 10 24 60 40 00 03 40 18 05 49 40 18 " +
        "00 2B 05 D0 01 78 11 70 01 30 01 32 01 3B F9 D1 " +
        "10 BC 70 47 00 00 72 08",
    );

    const PUBLIC_READ_STUB = READ_STUB.slice();

    async function validatedRomProfile(romInput) {
      const rom = asBytes(romInput, "ROM");
      if (rom.length !== ROM_SIZE) {
        throw new PatcherError(
          `ROM size is 0x${rom.length.toString(16).toUpperCase()}; expected 0x${ROM_SIZE.toString(16).toUpperCase()}`,
        );
      }
      const digest = await sha256(rom);
      const profile = ROM_PROFILES_BY_SHA256.get(digest);
      if (!profile) {
        throw new PatcherError(
          "Unsupported base ROM; expected e-Reader (USA) or Card e-Reader+ (Japan).",
        );
      }
      if (
        !bytesEqual(rom.subarray(0xa0, 0xac), profile.title) ||
        !bytesEqual(rom.subarray(0xac, 0xb0), profile.gameCode)
      ) {
        throw new PatcherError(`ROM header is not the supported ${profile.name} revision`);
      }
      for (let offset = ROM_BANK1_OFFSET; offset < rom.length; offset += 1) {
        if (rom[offset] !== 0xff) {
          throw new PatcherError("Expected free 0xFF ROM space from 0x720000 onward");
        }
      }
      return profile;
    }

    async function validateRom(romInput) {
      return snapshotRomProfile(await validatedRomProfile(romInput));
    }

    function applyCheckedPatch(rom, patch) {
      const actual = rom.subarray(patch.offset, patch.offset + patch.expected.length);
      if (!bytesEqual(actual, patch.expected)) {
        throw new PatcherError(
          `Unexpected bytes at ROM offset 0x${patch.offset.toString(16).toUpperCase()} for '${patch.description}': ${bytesToHex(actual, " ")}`,
        );
      }
      if (patch.expected.length !== patch.replacement.length) {
        throw new Error("In-place patch changes length");
      }
      rom.set(patch.replacement, patch.offset);
    }

    function mappedSaveRead(romInput, sector, offset, size) {
      const rom = asBytes(romInput, "ROM");
      const logicalSector = sector & 0x1f;
      const bankOffset = logicalSector & 0x10 ? ROM_BANK1_OFFSET : ROM_BANK0_OFFSET;
      const start = bankOffset + (logicalSector & 0x0f) * 0x1000 + offset;
      return binary.cloneBytes(rom.subarray(start, start + size));
    }

    function importedSaveImage(save, recordSize) {
      const imported = new Uint8Array(SAVE_SIZE).fill(0xff);
      imported.set(save.subarray(SAVED_RECORD_START, SAV_BANK1_IMPORT_END), SAVED_RECORD_START);
      const overflowSize = Math.max(0, recordSize - SAVED_RECORD_PRIMARY_SIZE);
      imported.set(save.subarray(0, overflowSize), 0);
      return imported;
    }

    function embedSaveImage(patched, save) {
      patched.set(save.subarray(SAVE_BANK_SIZE), ROM_BANK1_OFFSET);
      patched.set(save.subarray(0, SAVE_BANK_SIZE), ROM_BANK0_OFFSET);
    }

    function thumbBl(sourceAddress, targetAddress) {
      const offset = targetAddress - (sourceAddress + 4);
      if ((offset & 1) !== 0 || offset < -(1 << 22) || offset >= 1 << 22) {
        throw new PatcherError("Thumb BL target is out of range or misaligned");
      }
      const encoded = offset & 0x7fffff;
      const result = new Uint8Array(4);
      writeU16LE(result, 0, 0xf000 | ((encoded >>> 12) & 0x07ff));
      writeU16LE(result, 2, 0xf800 | ((encoded >>> 1) & 0x07ff));
      return result;
    }

    function appendBytes(target, source) {
      target.push(...asBytes(source));
    }

    function appendU16(target, value) {
      target.push(value & 0xff, (value >>> 8) & 0xff);
    }

    function appendU32(target, value) {
      target.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    }

    function padBytes(target, length) {
      if (target.length > length) {
        throw new Error("Native-card bootstrap layout overlaps its next routine");
      }
      while (target.length < length) {
        target.push(0xff);
      }
    }

    function nativeCardBootStub(profile, shortStrip) {
      const stubAddress = 0x08000000 + profile.stubOffset;
      const readerRelativeOffset = 0x70;
      const irqRestoreRelativeOffset = 0xe0;
      const scanResetRelativeOffset = 0x110;
      const nativeContextRelativeOffset = 0x130;
      const boot = [];

      const bootTargets = [
        stubAddress + readerRelativeOffset,
        stubAddress + nativeContextRelativeOffset,
        profile.scanOverlayRestoreAddress,
        stubAddress + scanResetRelativeOffset,
        stubAddress + irqRestoreRelativeOffset,
      ];
      for (const target of bootTargets) {
        appendBytes(boot, thumbBl(stubAddress + boot.length, target));
      }
      appendBytes(
        boot,
        bytesFromHex("04 49 08 88 02 30 04 28 00 D3 01 38 02 49 08 60 02 48 00 47"),
      );
      appendU32(boot, profile.formatAddress - 2);
      appendU32(boot, profile.outerStateAddress);
      appendU32(boot, profile.frameDispatchAddress);

      padBytes(boot, readerRelativeOffset);
      const readerAddress = stubAddress + readerRelativeOffset;
      const reader = [];
      appendU16(reader, 0xb5f0);
      appendU16(reader, 0x2001);
      appendBytes(reader, thumbBl(readerAddress + reader.length, profile.scanPrepareAddress));
      appendBytes(reader, thumbBl(readerAddress + reader.length, profile.scanSetupAddress));
      appendU16(reader, 0x4d10);
      appendU16(reader, shortStrip ? 0x2601 : 0x2600);
      appendU16(reader, 0x802e);
      appendU16(reader, 0x4c10);
      appendU16(reader, 0x4d10);
      appendU16(reader, 0x260c);
      appendBytes(reader, bytesFromHex("27 68 2F 60 04 34 04 35 04 3E F9 D1"));
      appendU16(reader, 0x4d0d);
      appendU16(reader, 0x4e0e);
      appendBytes(reader, bytesFromHex("27 68 2F 60 04 34 04 35 04 3E F9 D1"));
      appendU16(reader, 0x4c0b);
      appendU16(reader, 0x4d0c);
      appendU16(reader, 0x260c);
      appendBytes(reader, bytesFromHex("27 68 2F 60 04 34 04 35 04 3E F9 D1"));
      appendBytes(reader, thumbBl(readerAddress + reader.length, profile.parserAddress));
      appendBytes(reader, bytesFromHex("00 20 F0 BD C0 46"));
      if (reader.length !== 0x50) {
        throw new Error("Native-card reader routine layout changed");
      }
      for (const value of [
        profile.formatAddress,
        0x08000000 + NATIVE_CARD_DATA_OFFSET,
        profile.headerAddress,
        profile.payloadAddress,
        RAW_LONG_BIN_SIZE - 12,
        0x08000000 + NATIVE_CARD_DATA_OFFSET + RAW_LONG_BIN_SIZE,
        profile.validationHeaderAddress,
      ]) {
        appendU32(reader, value);
      }
      appendBytes(boot, Uint8Array.from(reader));

      padBytes(boot, irqRestoreRelativeOffset);
      appendBytes(
        boot,
        bytesFromHex(
          "07 4B 00 20 18 80 07 4A 10 88 01 21 08 43 10 80 " +
            "05 4A 10 88 08 21 08 43 10 80 01 20 18 80 70 47",
        ),
      );
      appendU32(boot, 0x04000208);
      appendU32(boot, 0x04000200);
      appendU32(boot, 0x04000004);

      padBytes(boot, scanResetRelativeOffset);
      appendU16(boot, 0xb500);
      for (const target of profile.scanResetAddresses) {
        appendBytes(boot, thumbBl(stubAddress + boot.length, target));
      }
      appendU16(boot, 0xbd00);

      padBytes(boot, nativeContextRelativeOffset);
      appendBytes(
        boot,
        bytesFromHex(
          "05 48 06 49 01 60 00 21 41 60 05 49 81 60 01 21 C1 60 " + "70 47 C0 46 C0 46",
        ),
      );
      appendU32(boot, profile.nativeContextAddress);
      appendU32(boot, 0x00030000);
      appendU32(boot, 0x000c0000);
      return Uint8Array.from(boot);
    }

    function nativeCardRecord(decoded) {
      const app = decoded.app;
      if (![RAW_SHORT_BIN_SIZE, RAW_LONG_BIN_SIZE].includes(app.length)) {
        throw new PatcherError("Native card has an unsupported logical data size");
      }
      const record = new Uint8Array(RAW_LONG_BIN_SIZE + 12);
      record.set(app.subarray(2, 4), 0);
      record.set(app.subarray(0, 2), 2);
      record.set(app.subarray(4, 12), 4);
      record.set(app.subarray(12), 12);
      record.set(app.subarray(0, 12), RAW_LONG_BIN_SIZE);
      return record;
    }

    function nativeSupportSave(region) {
      const isJpn = region !== 1;
      const supportLayout = dotcodeSaveLayout(
        isJpn ? PROGRAM_EXECUTION_GBA : PROGRAM_EXECUTION_Z80,
        0,
        region,
      );
      return buildVirtualSave({
        title: "Native card",
        titleBytes: asciiBytes("Native card"),
        region,
        programType: supportLayout.programType,
        savePrefixSize: supportLayout.prefixSize,
        payload: isJpn ? new Uint8Array([0, 0]) : asciiBytes("vpk0\0\0\0\0"),
        stripCount: 0,
      });
    }

    function finalizeRomHeaderAndReadStub(patched, profile) {
      if (!(patched instanceof Uint8Array) || patched.length !== ROM_SIZE) {
        throw new Error("ROM finalizer requires one complete writable base-ROM copy");
      }
      if (STANDALONE_ROM_TITLE.length !== ROM_TITLE_SIZE) {
        throw new Error(`standalone ROM title must occupy exactly ${ROM_TITLE_SIZE} bytes`);
      }

      const expectedMarker = asciiBytes("ROMONLY_V103");
      if (
        !bytesEqual(
          patched.subarray(
            profile.saveMarkerOffset,
            profile.saveMarkerOffset + expectedMarker.length,
          ),
          expectedMarker,
        )
      ) {
        throw new Error("Patched ROM still advertises cartridge FLASH storage");
      }

      const readStubEnd = READ_STUB_OFFSET + READ_STUB.length;
      if (readStubEnd > ROM_BANK1_OFFSET) {
        throw new Error("Thumb read-stub overlaps the content area");
      }
      if (!patched.subarray(READ_STUB_OFFSET, readStubEnd).every((value) => value === 0xff)) {
        throw new PatcherError("Thumb read-stub location is not free");
      }
      if (
        !bytesEqual(
          patched.subarray(GAME_CODE_OFFSET, GAME_CODE_OFFSET + profile.privateGameCode.length),
          profile.privateGameCode,
        )
      ) {
        throw new Error("Patched ROM does not contain the private standalone game code");
      }

      patched.set(STANDALONE_ROM_TITLE, ROM_TITLE_OFFSET);
      let headerSum = 0;
      for (let offset = 0xa0; offset < 0xbd; offset += 1) {
        headerSum += patched[offset];
      }
      patched[HEADER_CHECKSUM_OFFSET] = (-headerSum - 0x19) & 0xff;
      patched.set(READ_STUB, READ_STUB_OFFSET);
      return decodeAscii(
        firstNull(patched.subarray(ROM_TITLE_OFFSET, ROM_TITLE_OFFSET + ROM_TITLE_SIZE)),
      );
    }

    async function buildNativeDotcodeRom(romInput, rawInput, label = "RAW input") {
      const rom = asBytes(romInput, "ROM");
      const raw = asBytes(rawInput, label);
      const profile = await validatedRomProfile(rom);
      const nativeProfile = NATIVE_CARD_PROFILES[profile.key];
      const decoded = decodeRawDotcodeDetails(raw, label);
      const inspected = inspectDecodedDotcode(decoded, label);
      if (inspected.contentKind === "application") {
        throw new PatcherError("application cards must be assembled as a complete set");
      }
      const contentRegion = decoded.region === 1 ? "usa" : "japan";
      if (profile.key !== contentRegion) {
        const requiredName = contentRegion === "usa" ? USA_ROM_PROFILE.name : JPN_ROM_PROFILE.name;
        const contentRegionLabel = contentRegion === "usa" ? "English" : "Japanese";
        throw new PatcherError(
          `${contentRegionLabel} dot-code content requires the ${requiredName} base ROM`,
        );
      }

      const patched = binary.cloneBytes(rom);
      for (const patch of profile.patches) {
        if (
          patch.offset !== nativeProfile.bootOffset &&
          patch.offset !== nativeProfile.returnPatchOffset
        ) {
          applyCheckedPatch(patched, patch);
        }
      }

      const stub = nativeCardBootStub(nativeProfile, decoded.app.length === RAW_SHORT_BIN_SIZE);
      const stubEnd = nativeProfile.stubOffset + stub.length;
      if (!patched.subarray(nativeProfile.stubOffset, stubEnd).every((value) => value === 0xff)) {
        throw new PatcherError("Native-card bootstrap location is not free");
      }
      patched.set(stub, nativeProfile.stubOffset);
      applyCheckedPatch(
        patched,
        binaryPatch(
          nativeProfile.bootOffset,
          nativeProfile.bootExpected,
          thumbBl(0x08000000 + nativeProfile.bootOffset, 0x08000000 + nativeProfile.stubOffset),
          "start the embedded card through the native dot-code dispatcher",
        ),
      );
      if (inspected.contentKind === "pokedex") {
        // B normally changes the viewer's inner state to 7, fades out, and
        // returns to front-end state 12. Keep the displayed entry unchanged.
        applyCheckedPatch(
          patched,
          binaryPatch(
            nativeProfile.viewerExitOffset,
            nativeProfile.viewerExitExpected,
            bytesFromHex("00 46"),
            "ignore the Pokémon Viewer's return-to-menu transition",
          ),
        );
      }
      // All native handlers eventually return through front-end state 12. A
      // BIOS SoftReset restarts the patched ROM without inheriting handler UI
      // state. The trailing self-branch fails closed if SWI 0 ever returns.
      applyCheckedPatch(
        patched,
        binaryPatch(
          nativeProfile.mainMenuOffset,
          nativeProfile.mainMenuExpected,
          bytesFromHex("00 DF FE E7"),
          "soft-reset native content instead of entering the main menu",
        ),
      );

      const supportSave = nativeSupportSave(decoded.region);
      embedSaveImage(patched, importedSaveImage(supportSave, validateSave(supportSave).recordSize));
      patched.set(nativeCardRecord(decoded), NATIVE_CARD_DATA_OFFSET);

      const title = inspected.embeddedTitle;
      const romTitle = finalizeRomHeaderAndReadStub(patched, profile);
      if (!patched.subarray(NATIVE_CARD_DATA_END).every((value) => value === 0xff)) {
        throw new Error("Generated ROM contains data after the native card");
      }

      return {
        rom: patched,
        metadata: {
          ...inspected,
          title,
          sourceKind: "RAW",
          romProfile: profile.key,
          romName: profile.name,
          romTitle,
          gameCode: decodeAscii(profile.privateGameCode),
        },
      };
    }

    async function buildPatchedRom(romInput, saveInput, applicationRegionHint = null) {
      const rom = asBytes(romInput, "ROM");
      const save = asBytes(saveInput, "save");
      const profile = await validatedRomProfile(rom);
      const parsedSave = saveFormat.parseSave(save);
      const metadata = parsedSave.metadata;
      const detectedRegion = metadata.applicationRegion;
      if (applicationRegionHint !== null && !["usa", "japan"].includes(applicationRegionHint)) {
        throw new PatcherError(`Unknown application region: ${applicationRegionHint}`);
      }
      if (metadata.storedRegionCode === JPN_SAVED_REGION_CODE && applicationRegionHint === "usa") {
        throw new PatcherError("e-Reader+ application data requires the Japanese base ROM");
      }
      const applicationRegion = applicationRegionHint ?? detectedRegion;
      if (profile.key !== applicationRegion) {
        const requiredName =
          applicationRegion === "japan" ? JPN_ROM_PROFILE.name : USA_ROM_PROFILE.name;
        const applicationRegionLabel = applicationRegion === "japan" ? "Japanese" : "English";
        throw new PatcherError(
          `${applicationRegionLabel} application '${metadata.title}' requires the ${requiredName} base ROM`,
        );
      }
      metadata.applicationRegion = applicationRegion;
      metadata.romProfile = profile.key;
      metadata.romName = profile.name;
      const patched = binary.cloneBytes(rom);

      const importedSave = importedSaveImage(save, metadata.recordSize);
      embedSaveImage(patched, importedSave);

      for (const patch of profile.patches) {
        applyCheckedPatch(patched, patch);
      }

      metadata.romTitle = finalizeRomHeaderAndReadStub(patched, profile);
      metadata.gameCode = decodeAscii(profile.privateGameCode);

      for (let sector = 0; sector < 32; sector += 1) {
        const embedded = mappedSaveRead(patched, sector, 0, 0x1000);
        const expected = importedSave.subarray(sector * 0x1000, (sector + 1) * 0x1000);
        if (!bytesEqual(embedded, expected)) {
          throw new Error(`embedded save mapping failed for sector ${sector}`);
        }
      }

      const embeddedRecord = savedRecordBytes(importedSave, metadata.recordSize);
      const payloadStart = metadata.payloadOffset;
      const payloadEnd = payloadStart + metadata.payloadSize;
      const expectedPayload = parsedSave.payload;
      if (!bytesEqual(embeddedRecord.subarray(payloadStart, payloadEnd), expectedPayload)) {
        throw new Error("Saved-program payload is not present in the ROM-backed save");
      }
      for (let offset = ROM_SAVE_IMAGE_END; offset < patched.length; offset += 1) {
        if (patched[offset] !== 0xff) {
          throw new Error("Generated ROM contains data after the content area");
        }
      }
      return { rom: patched, metadata };
    }

    const constants = Object.freeze({
      ADDITIONAL_SCAN_OFFSET: scanModule.RAW_OFFSET,
      ADDITIONAL_SCAN_SLOT_SIZE: scanModule.SLOT_SIZE,
      MAX_ADDITIONAL_SCANS: scanModule.MAX_CARDS,
      ROM_SIZE,
      SAVE_SIZE,
      SAVE_BANK_SIZE,
      CALIBRATION_SECTOR_SIZE,
      CALIBRATION_PRIMARY_OFFSET,
      CALIBRATION_SECONDARY_OFFSET,
      SAVED_RECORD_START,
      SAVED_RECORD_PRIMARY_SIZE,
      SAVED_RECORD_MAX_SIZE,
      SAV_BANK1_IMPORT_END,
      EXPECTED_USA_ROM_SHA256,
      EXPECTED_JPN_ROM_SHA256,
      ROM_BANK1_OFFSET,
      ROM_BANK0_OFFSET,
      ROM_SAVE_IMAGE_END,
      NATIVE_CARD_DATA_OFFSET,
      NATIVE_CARD_DATA_END,
      READ_STUB_OFFSET,
      READ_STUB_ADDRESS,
      ROM_TITLE_OFFSET,
      ROM_TITLE_SIZE,
      GAME_CODE_OFFSET,
      HEADER_CHECKSUM_OFFSET,
      USA_ERASE_MENU_BYPASS_OFFSET,
      JPN_ERASE_MENU_BYPASS_OFFSET,
      RAW_LONG_SIZE,
      RAW_SHORT_SIZE,
      RAW_LONG_BIN_SIZE,
      RAW_SHORT_BIN_SIZE,
      PROGRAM_TYPE_DISPATCH_MASK,
      PROGRAM_TYPE_CARD_HEADER_SHIFT,
      PROGRAM_TYPE_STORED_REGION_SHIFT,
      PROGRAM_TYPE_STORED_REGION_MASK,
    });

    return Object.freeze({
      PatcherError,
      constants,
      profiles: PUBLIC_ROM_PROFILES,
      patches: PUBLIC_PATCHES,
      readStub: PUBLIC_READ_STUB,
      asBytes,
      bytesEqual,
      bytesToHex,
      sha256,
      crc32,
      validateRom,
      validateSave,
      extractSaveCalibration,
      applySaveCalibration,
      extractSavePayload,
      decodeJapaneseShortTitle,
      japaneseShortTitleToShiftJis,
      decodeRawDotcode,
      inspectRawDotcode,
      inspectScanCard,
      encodeRawDotcode,
      selectRawSet,
      rawFilesToApplication,
      saveToRawDotcodes,
      buildVirtualSave,
      setSaveApplicationTitle,
      applyCheckedPatch,
      mappedSaveRead,
      buildNativeDotcodeRom,
      buildPatchedRom,
      buildAdditionalScanRom: scanEmulation.buildRom,
    });
  },
);
