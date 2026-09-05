(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./binary.js"));
  } else {
    root.EReaderZipArchive = factory(root.EReaderBinary);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (binary) {
  "use strict";

  const { crc32 } = binary;

  function asBytes(input) {
    try {
      return binary.asBytes(input);
    } catch (error) {
      if (error instanceof TypeError) throw new TypeError("ZIP input must be binary data.");
      throw error;
    }
  }

  const EOCD_SIGNATURE = 0x06054b50;

  const CENTRAL_FILE_SIGNATURE = 0x02014b50;

  const LOCAL_FILE_SIGNATURE = 0x04034b50;

  const ZIP64_SENTINEL_16 = 0xffff;

  const ZIP64_SENTINEL_32 = 0xffffffff;

  const MAX_ENTRY_COUNT = 512;

  const MAX_ENTRY_SIZE = 32 * 1024 * 1024;

  const MAX_TOTAL_SIZE = 128 * 1024 * 1024;

  const MAX_ARCHIVE_SIZE = 64 * 1024 * 1024;

  const MAX_EOCD_SEARCH = 0xffff + 22;

  const UTF8_FLAG = 0x0800;

  const ENCRYPTED_FLAG = 0x0001;

  const SUPPORTED_METHODS = new Set([0, 8]);

  const CP437_HIGH =
    "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
    "áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
    "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
    "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

  class ZipArchiveError extends Error {
    constructor(message) {
      super(message);
      this.name = "ZipArchiveError";
    }
  }

  function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function requireRange(bytes, offset, size, label) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > bytes.length
    ) {
      throw new ZipArchiveError(`${label} is truncated.`);
    }
  }

  function u16(view, offset) {
    return view.getUint16(offset, true);
  }

  function u32(view, offset) {
    return view.getUint32(offset, true);
  }

  function findEndOfCentralDirectory(bytes, view) {
    const minimumOffset = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
    for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
      if (u32(view, offset) !== EOCD_SIGNATURE) {
        continue;
      }
      const commentLength = u16(view, offset + 20);
      if (offset + 22 + commentLength === bytes.length) {
        return offset;
      }
    }
    throw new ZipArchiveError("The ZIP end record is missing or invalid.");
  }

  function decodeCp437(bytes) {
    let result = "";
    for (const byte of bytes) {
      result += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
    }
    return result;
  }

  function decodeUtf8(bytes, label) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (_error) {
      throw new ZipArchiveError(`${label} contains an invalid UTF-8 filename.`);
    }
  }

  function unicodePathFromExtra(extra, originalName) {
    const view = viewOf(extra);
    let offset = 0;
    while (offset + 4 <= extra.length) {
      const fieldId = u16(view, offset);
      const fieldSize = u16(view, offset + 2);
      offset += 4;
      requireRange(extra, offset, fieldSize, "ZIP extra field");
      if (fieldId === 0x7075 && fieldSize >= 5 && extra[offset] === 1) {
        const storedNameCrc = u32(view, offset + 1);
        if (storedNameCrc === crc32(originalName)) {
          return decodeUtf8(extra.subarray(offset + 5, offset + fieldSize), "ZIP entry");
        }
      }
      offset += fieldSize;
    }
    if (offset !== extra.length) {
      throw new ZipArchiveError("A ZIP extra field is truncated.");
    }
    return "";
  }

  function decodeEntryName(nameBytes, extra, flags) {
    const unicodeName = unicodePathFromExtra(extra, nameBytes);
    const decoded =
      unicodeName ||
      (flags & UTF8_FLAG ? decodeUtf8(nameBytes, "ZIP entry") : decodeCp437(nameBytes));
    if (decoded.includes("\u0000")) {
      throw new ZipArchiveError("A ZIP entry filename contains a null character.");
    }
    return decoded.replace(/\\/g, "/");
  }

  function safeEntryName(archivePath) {
    const parts = archivePath.split("/").filter(Boolean);
    const name = parts.at(-1) || "";
    if (!name || name === "." || name === "..") {
      return "";
    }
    return name.replace(/[\u0000-\u001f]/g, "_");
  }

  function extensionOf(filename) {
    const match = /\.([^.]+)$/.exec(filename);
    return match ? `.${match[1].toLocaleLowerCase("en-US")}` : "";
  }

  function readCentralDirectory(bytes, acceptedExtensions) {
    if (bytes.length > MAX_ARCHIVE_SIZE) {
      throw new ZipArchiveError("The ZIP archive exceeds the 64 MiB limit.");
    }
    if (bytes.length < 22) {
      throw new ZipArchiveError("The ZIP archive is too short.");
    }
    const view = viewOf(bytes);
    const eocdOffset = findEndOfCentralDirectory(bytes, view);
    const diskNumber = u16(view, eocdOffset + 4);
    const directoryDisk = u16(view, eocdOffset + 6);
    const entriesOnDisk = u16(view, eocdOffset + 8);
    const entryCount = u16(view, eocdOffset + 10);
    const directorySize = u32(view, eocdOffset + 12);
    const directoryOffset = u32(view, eocdOffset + 16);
    if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
      throw new ZipArchiveError("Multi-volume ZIP archives are not supported.");
    }
    if (
      entryCount === ZIP64_SENTINEL_16 ||
      directorySize === ZIP64_SENTINEL_32 ||
      directoryOffset === ZIP64_SENTINEL_32
    ) {
      throw new ZipArchiveError("ZIP64 archives are not supported.");
    }
    if (entryCount > MAX_ENTRY_COUNT) {
      throw new ZipArchiveError(`The ZIP archive contains more than ${MAX_ENTRY_COUNT} entries.`);
    }
    requireRange(bytes, directoryOffset, directorySize, "ZIP central directory");
    if (directoryOffset + directorySize > eocdOffset) {
      throw new ZipArchiveError("The ZIP central directory overlaps its end record.");
    }

    const entries = [];
    let totalSize = 0;
    let cursor = directoryOffset;
    for (let index = 0; index < entryCount; index += 1) {
      requireRange(bytes, cursor, 46, "ZIP central-directory entry");
      if (u32(view, cursor) !== CENTRAL_FILE_SIGNATURE) {
        throw new ZipArchiveError("A ZIP central-directory entry has an invalid signature.");
      }
      const flags = u16(view, cursor + 8);
      const method = u16(view, cursor + 10);
      const expectedCrc = u32(view, cursor + 16);
      const compressedSize = u32(view, cursor + 20);
      const uncompressedSize = u32(view, cursor + 24);
      const nameLength = u16(view, cursor + 28);
      const extraLength = u16(view, cursor + 30);
      const commentLength = u16(view, cursor + 32);
      const startDisk = u16(view, cursor + 34);
      const localOffset = u32(view, cursor + 42);
      const variableSize = nameLength + extraLength + commentLength;
      requireRange(bytes, cursor + 46, variableSize, "ZIP central-directory entry");
      if (
        compressedSize === ZIP64_SENTINEL_32 ||
        uncompressedSize === ZIP64_SENTINEL_32 ||
        localOffset === ZIP64_SENTINEL_32
      ) {
        throw new ZipArchiveError("ZIP64 entries are not supported.");
      }
      if (startDisk !== 0) {
        throw new ZipArchiveError("Multi-volume ZIP entries are not supported.");
      }

      const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
      const extra = bytes.subarray(
        cursor + 46 + nameLength,
        cursor + 46 + nameLength + extraLength,
      );
      const archivePath = decodeEntryName(nameBytes, extra, flags);
      const name = safeEntryName(archivePath);
      const directory = archivePath.endsWith("/");
      const accepted = !directory && acceptedExtensions.has(extensionOf(name));
      if (accepted) {
        if (flags & ENCRYPTED_FLAG) {
          throw new ZipArchiveError(`${name} is encrypted; encrypted entries are not supported.`);
        }
        if (!SUPPORTED_METHODS.has(method)) {
          throw new ZipArchiveError(`${name} uses an unsupported ZIP compression method.`);
        }
        if (uncompressedSize > MAX_ENTRY_SIZE) {
          throw new ZipArchiveError(`${name} exceeds the 64 MiB extracted-file limit.`);
        }
        totalSize += uncompressedSize;
        if (totalSize > MAX_TOTAL_SIZE) {
          throw new ZipArchiveError(
            "The supported files in the ZIP exceed the 128 MiB total limit.",
          );
        }
        entries.push({
          name,
          nameBytes: binary.cloneBytes(nameBytes),
          flags,
          method,
          expectedCrc,
          compressedSize,
          uncompressedSize,
          localOffset,
          dataBoundary: directoryOffset,
        });
      }
      cursor += 46 + variableSize;
    }
    if (cursor !== directoryOffset + directorySize) {
      throw new ZipArchiveError("The ZIP central-directory size is inconsistent.");
    }
    return { entries, ignoredCount: entryCount - entries.length };
  }

  async function inflateRaw(compressed, expectedSize, name) {
    if (typeof DecompressionStream !== "function") {
      throw new ZipArchiveError(
        "This browser cannot decompress ZIP files. A browser with Deflate support is required.",
      );
    }
    let stream;
    try {
      stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    } catch (_error) {
      throw new ZipArchiveError(`${name} could not be opened as Deflate data.`);
    }
    const reader = stream.getReader();
    const output = new Uint8Array(expectedSize);
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const offset = size;
        size += value.byteLength;
        if (size > expectedSize || size > MAX_ENTRY_SIZE) {
          throw new ZipArchiveError(`${name} expands beyond its declared size.`);
        }
        output.set(value, offset);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof ZipArchiveError) {
        throw error;
      }
      throw new ZipArchiveError(`${name} contains invalid Deflate data.`);
    } finally {
      reader.releaseLock();
    }
    if (size !== expectedSize) {
      throw new ZipArchiveError(`${name} has an incorrect extracted size.`);
    }
    return output;
  }

  async function extractEntry(bytes, entry) {
    const view = viewOf(bytes);
    requireRange(bytes, entry.localOffset, 30, `Local ZIP header for ${entry.name}`);
    if (u32(view, entry.localOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new ZipArchiveError(`The local ZIP header for ${entry.name} is invalid.`);
    }
    const localFlags = u16(view, entry.localOffset + 6);
    const localMethod = u16(view, entry.localOffset + 8);
    const nameLength = u16(view, entry.localOffset + 26);
    const extraLength = u16(view, entry.localOffset + 28);
    if (
      (localFlags & ENCRYPTED_FLAG) !== (entry.flags & ENCRYPTED_FLAG) ||
      localMethod !== entry.method
    ) {
      throw new ZipArchiveError(`The ZIP headers for ${entry.name} are inconsistent.`);
    }
    requireRange(
      bytes,
      entry.localOffset + 30,
      nameLength + extraLength,
      `Local ZIP header for ${entry.name}`,
    );
    const localName = bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength);
    if (
      localName.length !== entry.nameBytes.length ||
      localName.some((byte, index) => byte !== entry.nameBytes[index])
    ) {
      throw new ZipArchiveError(`The ZIP filenames for ${entry.name} are inconsistent.`);
    }
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    requireRange(bytes, dataOffset, entry.compressedSize, `Compressed data for ${entry.name}`);
    if (dataOffset + entry.compressedSize > entry.dataBoundary) {
      throw new ZipArchiveError(`The compressed data for ${entry.name} overlaps the directory.`);
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressedSize);
    let output;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.uncompressedSize) {
        throw new ZipArchiveError(`${entry.name} has inconsistent stored sizes.`);
      }
      output = binary.cloneBytes(compressed);
    } else {
      output = await inflateRaw(compressed, entry.uncompressedSize, entry.name);
    }
    if (output.length !== entry.uncompressedSize) {
      throw new ZipArchiveError(`${entry.name} has an incorrect extracted size.`);
    }
    if (crc32(output) !== entry.expectedCrc) {
      throw new ZipArchiveError(`${entry.name} failed its ZIP checksum.`);
    }
    return output;
  }

  async function extractSupportedFiles(input, extensions) {
    const bytes = asBytes(input);
    const acceptedExtensions = new Set(
      Array.from(extensions, (extension) => String(extension).toLocaleLowerCase("en-US")),
    );
    const directory = readCentralDirectory(bytes, acceptedExtensions);
    const files = [];
    for (const entry of directory.entries) {
      files.push({
        name: entry.name,
        bytes: await extractEntry(bytes, entry),
      });
    }
    return Object.freeze({
      files: Object.freeze(files),
      ignoredCount: directory.ignoredCount,
    });
  }

  return Object.freeze({
    MAX_ARCHIVE_SIZE,
    extractSupportedFiles,
  });
});
