export interface ImageHeader {
  media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
}

function ascii({ bytes, offset, text }: { bytes: Uint8Array; offset: number; text: string }): boolean {
  if (offset + text.length > bytes.length) {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function sized(header: ImageHeader): ImageHeader | undefined {
  return header.width > 0 && header.height > 0 ? header : undefined;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readPng(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    return undefined;
  }
  if (!ascii({ bytes, offset: 12, text: 'IHDR' })) {
    return undefined;
  }
  return sized({ media_type: 'image/png', width: view.getUint32(16), height: view.getUint32(20) });
}

function readGif(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
  if (
    bytes.length < 10 ||
    !(ascii({ bytes, offset: 0, text: 'GIF87a' }) || ascii({ bytes, offset: 0, text: 'GIF89a' }))
  ) {
    return undefined;
  }
  return sized({ media_type: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) });
}

/** SOF markers carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but do not. */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readJpeg(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // End of image or start of scan before any frame header.
    if (marker === 0xd9 || marker === 0xda) {
      return undefined;
    }
    const length = view.getUint16(offset + 2);
    if (isStartOfFrame(marker)) {
      if (offset + 9 > bytes.length) {
        return undefined;
      }
      return sized({ media_type: 'image/jpeg', width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) });
    }
    if (length < 2) {
      return undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

function readWebp(bytes: Uint8Array, view: DataView): ImageHeader | undefined {
  if (!ascii({ bytes, offset: 0, text: 'RIFF' }) || !ascii({ bytes, offset: 8, text: 'WEBP' }) || bytes.length < 30) {
    return undefined;
  }
  // Lossy: a VP8 key frame, start code 9d 01 2a, then 14-bit width and height.
  if (ascii({ bytes, offset: 12, text: 'VP8 ' })) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return undefined;
    }
    return sized({
      media_type: 'image/webp',
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    });
  }
  // Lossless: signature 2f, then width-1 and height-1 packed as two 14-bit fields.
  if (ascii({ bytes, offset: 12, text: 'VP8L' })) {
    if (bytes[20] !== 0x2f) {
      return undefined;
    }
    const bits = view.getUint32(21, true);
    return sized({ media_type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
  }
  // Extended: canvas width-1 and height-1 as 24-bit fields after 4 flag bytes.
  if (ascii({ bytes, offset: 12, text: 'VP8X' })) {
    const uint24 = (at: number): number => view.getUint16(at, true) + ((bytes[at + 2] ?? 0) << 16);
    return sized({ media_type: 'image/webp', width: uint24(24) + 1, height: uint24(27) + 1 });
  }
  return undefined;
}

/**
 * The format and pixel size an image's own header declares, for PNG, JPEG, GIF and WebP. Anything
 * else, a truncated header or a zero size, is undefined.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readPng(bytes, view) ?? readJpeg(bytes, view) ?? readGif(bytes, view) ?? readWebp(bytes, view);
}
