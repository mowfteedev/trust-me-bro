import { inflateRawSync } from 'node:zlib';

/** Read ZIP local records independently of the workbook serializer. */
export function spreadsheetParts(file: Buffer): Record<string, string> {
  const parts: Record<string, string> = {};
  let offset = 0;
  while (file.readUInt32LE(offset) === 0x04034b50) {
    const method = file.readUInt16LE(offset + 8); const length = file.readUInt32LE(offset + 18);
    const nameLength = file.readUInt16LE(offset + 26); const extra = file.readUInt16LE(offset + 28);
    const name = file.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extra;
    const compressed = file.subarray(start, start + length);
    if (method !== 8) throw new Error('Expected ZIP Deflate');
    parts[name] = inflateRawSync(compressed).toString();
    offset = start + length;
  }
  if (file.readUInt32LE(offset) !== 0x02014b50) throw new Error('Missing central directory');
  return parts;
}
