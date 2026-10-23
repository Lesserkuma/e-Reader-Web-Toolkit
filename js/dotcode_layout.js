(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.EReaderDotcodeLayout = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LONG_BLOCK_COUNT = 28;
  const SHORT_BLOCK_COUNT = 18;
  const BYTES_PER_BLOCK = 104;
  const BITS_PER_BLOCK = BYTES_PER_BLOCK * 10;
  const MODULATION_TABLE = Object.freeze([
    0x00, 0x01, 0x02, 0x12, 0x04, 0x05, 0x06, 0x16, 0x08, 0x09, 0x0a, 0x14, 0x0c, 0x0d, 0x11, 0x10,
  ]);

  function calculateDataPosition(index) {
    if (index < 78) {
      return [9 + (index % 26), 6 + Math.floor(index / 26)];
    }
    if (index < 962) {
      const middle = index - 78;
      return [5 + (middle % 34), 9 + Math.floor(middle / 34)];
    }
    const bottom = index - 962;
    return [9 + (bottom % 26), 35 + Math.floor(bottom / 26)];
  }

  const positions = Object.freeze(
    Array.from({ length: BITS_PER_BLOCK }, (_value, index) =>
      Object.freeze(calculateDataPosition(index)),
    ),
  );

  function dataPosition(index) {
    return positions[index];
  }

  function addressSequence(start, count) {
    const sequence = new Uint32Array(count);
    if (start === 0) sequence[0] = 0x3ff;
    let left = 0;
    let right = 0x3ff;
    for (let value = 1; value < start + count; value += 1) {
      left = right;
      let base = 0x769;
      right = (left ^ ((value & -value) * base)) >>> 0;
      for (let mask = 0x1fff, bits = 0x651; bits > 0; mask >>>= 1, bits >>>= 1) {
        if ((value & mask) === 0) {
          if (bits & 1) {
            right = (right ^ base) >>> 0;
          }
          base = (base << 1) >>> 0;
        }
      }
      if (value >= start) sequence[value - start] = right;
    }
    return sequence;
  }

  function createDotcodeGeometry(raw) {
    const blockCount = raw.length / BYTES_PER_BLOCK;
    const logicalWidth = blockCount * 35 + 9;
    const logicalHeight = 44;
    const dots = new Set();
    const addDot = (x, y) => dots.add(y * logicalWidth + x);

    const startAddress = raw[BYTES_PER_BLOCK + 1];
    const addresses = addressSequence(startAddress, blockCount + 1);
    for (let block = 0; block < blockCount; block += 1) {
      const leftX = block * 35 + 4;
      const rightX = (block + 1) * 35 + 4;
      addDot(leftX, 9);
      addDot(rightX, 9);
      for (let bit = 0; bit < 16; bit += 1) {
        if (addresses[block] & (1 << bit)) {
          addDot(leftX, 33 - bit);
        }
        if (addresses[block + 1] & (1 << bit)) {
          addDot(rightX, 33 - bit);
        }
      }

      for (let index = 0; index <= 5; index += 1) {
        for (const x of [block * 35 + 10 + index * 2, block * 35 + 23 + index * 2]) {
          addDot(x, 4);
          addDot(x, 39);
        }
      }

      let sampleIndex = 0;
      const blockOffset = block * BYTES_PER_BLOCK;
      for (let byteIndex = 0; byteIndex < BYTES_PER_BLOCK; byteIndex += 1) {
        const value = raw[blockOffset + byteIndex];
        for (let shift = 4; shift >= 0; shift -= 4) {
          const nibble = (value >>> shift) & 0x0f;
          const symbol = MODULATION_TABLE[nibble];
          for (let bit = 4; bit >= 0; bit -= 1) {
            if (symbol & (1 << bit)) {
              const [x, y] = dataPosition(sampleIndex);
              addDot(block * 35 + x, y);
            }
            sampleIndex += 1;
          }
        }
      }
      if (sampleIndex !== 1040) {
        throw new Error("Generated dot-code block has an invalid modulation size");
      }
    }

    return { blockCount, logicalWidth, logicalHeight, dots };
  }

  function readBlockData(raw, size) {
    const result = new Uint8Array(size);
    let offset = 0;
    for (let block = 0; offset < size; block += 1) {
      const count = Math.min(BYTES_PER_BLOCK - 2, size - offset);
      result.set(
        raw.subarray(block * BYTES_PER_BLOCK + 2, block * BYTES_PER_BLOCK + 2 + count),
        offset,
      );
      offset += count;
    }
    return result;
  }

  function writeBlockData(raw, data) {
    for (
      let offset = 0, block = 0;
      offset < data.length;
      offset += BYTES_PER_BLOCK - 2, block += 1
    ) {
      raw.set(data.subarray(offset, offset + BYTES_PER_BLOCK - 2), block * BYTES_PER_BLOCK + 2);
    }
  }

  function deinterleave(data, columns, wordSize) {
    const result = new Uint8Array(columns * wordSize);
    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row < wordSize; row += 1)
        result[column * wordSize + row] = data[row * columns + column];
    }
    return result;
  }

  function interleave(words, wordSize) {
    const columns = words.length / wordSize;
    const result = new Uint8Array(words.length);
    for (let row = 0; row < wordSize; row += 1) {
      for (let column = 0; column < columns; column += 1)
        result[row * columns + column] = words[column * wordSize + row];
    }
    return result;
  }

  return Object.freeze({
    createDotcodeGeometry,
    readBlockData,
    writeBlockData,
    deinterleave,
    interleave,
    addressSequence,
    LONG_BLOCK_COUNT,
    SHORT_BLOCK_COUNT,
    BYTES_PER_BLOCK,
    BITS_PER_BLOCK,
    MODULATION_TABLE,
    dataPosition,
  });
});
