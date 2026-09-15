const fs = require("fs");

function readStoredZipEntries(filePath) {
  const archive = fs.readFileSync(filePath);
  const entries = new Map();
  let offset = 0;

  while (offset + 4 <= archive.length) {
    const signature = archive.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }
    if (signature !== 0x04034b50) {
      throw new Error(`Unexpected ZIP signature at byte ${offset}`);
    }

    const compressionMethod = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const fileNameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    if (compressionMethod !== 0 || compressedSize !== uncompressedSize) {
      throw new Error("Test helper expected a stored ZIP entry");
    }

    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = archive.toString("utf8", nameStart, nameStart + fileNameLength);
    entries.set(name, archive.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }

  return entries;
}

module.exports = { readStoredZipEntries };
