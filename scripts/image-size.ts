import { open } from "node:fs/promises";

export interface ImageSize {
  width: number;
  height: number;
}

// How much of the file to read up front. PNG/GIF/WebP headers are tiny; JPEG
// markers (thumbnails, EXIF, ICC profiles) can push the SOF segment further
// in, so we read a generous prefix before giving up.
const HEADER_BYTES = 65536;

async function readHeader(path: string): Promise<Buffer | undefined> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function isValidSize(width: number, height: number): boolean {
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;
}

function readPng(buffer: Buffer): ImageSize | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24 || !signature.every((byte, index) => buffer[index] === byte)) {
    return undefined;
  }
  // IHDR is always the first chunk: width/height are big-endian u32 at 16/20.
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return isValidSize(width, height) ? { width, height } : undefined;
}

function readGif(buffer: Buffer): ImageSize | undefined {
  if (buffer.length < 10) return undefined;
  const header = buffer.toString("ascii", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return undefined;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return isValidSize(width, height) ? { width, height } : undefined;
}

// Markers that carry a length + payload but are never a start-of-frame.
// SOF markers are 0xC0-0xCF excluding DHT (0xC4), JPG (0xC8) and DAC (0xCC).
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// Standalone markers with no length/payload following them.
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

function readJpeg(buffer: Buffer): ImageSize | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;

  let offset = 2;
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) return undefined;

    // Skip fill bytes (0xFF padding) between markers.
    let markerOffset = offset + 1;
    while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) markerOffset++;
    if (markerOffset >= buffer.length) return undefined;

    const marker = buffer[markerOffset];
    if (marker === 0xd9 || marker === 0xda) return undefined; // EOI / SOS: no SOF found

    if (isStandaloneMarker(marker)) {
      offset = markerOffset + 1;
      continue;
    }

    const segmentStart = markerOffset + 1;
    if (segmentStart + 1 >= buffer.length) return undefined;
    const segmentLength = buffer.readUInt16BE(segmentStart);

    if (isSofMarker(marker)) {
      if (segmentStart + 6 >= buffer.length) return undefined;
      const height = buffer.readUInt16BE(segmentStart + 3);
      const width = buffer.readUInt16BE(segmentStart + 5);
      return isValidSize(width, height) ? { width, height } : undefined;
    }

    offset = segmentStart + segmentLength;
  }
  return undefined;
}

function readWebp(buffer: Buffer): ImageSize | undefined {
  if (buffer.length < 30) return undefined;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    return undefined;
  }
  const chunkType = buffer.toString("ascii", 12, 16);
  const chunkOffset = 20;

  if (chunkType === "VP8 ") {
    // Lossy: 3-byte start code, then 0x9d 0x01 0x2a signature, then 14-bit
    // width/height (top 2 bits are reserved scaling flags).
    if (
      buffer[chunkOffset + 3] !== 0x9d ||
      buffer[chunkOffset + 4] !== 0x01 ||
      buffer[chunkOffset + 5] !== 0x2a
    ) {
      return undefined;
    }
    const width = buffer.readUInt16LE(chunkOffset + 6) & 0x3fff;
    const height = buffer.readUInt16LE(chunkOffset + 8) & 0x3fff;
    return isValidSize(width, height) ? { width, height } : undefined;
  }

  if (chunkType === "VP8L") {
    // Lossless: 1-byte 0x2f signature, then a 4-byte little-endian bitstream
    // packing 14-bit (width-1) and 14-bit (height-1).
    if (buffer[chunkOffset] !== 0x2f) return undefined;
    const bits = buffer.readUInt32LE(chunkOffset + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return isValidSize(width, height) ? { width, height } : undefined;
  }

  if (chunkType === "VP8X") {
    // Extended: 24-bit little-endian (canvas width-1) / (canvas height-1).
    const flagsAndReserved = 4;
    const width =
      1 +
      (buffer[chunkOffset + flagsAndReserved] |
        (buffer[chunkOffset + flagsAndReserved + 1] << 8) |
        (buffer[chunkOffset + flagsAndReserved + 2] << 16));
    const height =
      1 +
      (buffer[chunkOffset + flagsAndReserved + 3] |
        (buffer[chunkOffset + flagsAndReserved + 4] << 8) |
        (buffer[chunkOffset + flagsAndReserved + 5] << 16));
    return isValidSize(width, height) ? { width, height } : undefined;
  }

  return undefined;
}

export async function readImageSize(path: string): Promise<ImageSize | undefined> {
  try {
    const buffer = await readHeader(path);
    if (!buffer) return undefined;
    return readPng(buffer) ?? readGif(buffer) ?? readWebp(buffer) ?? readJpeg(buffer);
  } catch {
    return undefined;
  }
}
