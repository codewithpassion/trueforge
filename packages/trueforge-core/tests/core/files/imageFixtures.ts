/** Just enough of each format for header sniffing; the pixel data is not valid. */

function be16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function le16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function chars(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

export function pngBytes({ width, height }: { width: number; height: number }): Uint8Array {
  return new Uint8Array([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...be32(13),
    ...chars('IHDR'),
    ...be32(width),
    ...be32(height),
    ...[8, 6, 0, 0, 0],
    ...[0, 0, 0, 0],
  ]);
}

/** An APP0 and a DHT segment come first, as in real files, so the SOF has to be found by walking. */
export function jpegBytes({ width, height }: { width: number; height: number }): Uint8Array {
  return new Uint8Array([
    ...[0xff, 0xd8],
    ...[0xff, 0xe0, ...be16(16), ...chars('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    ...[0xff, 0xc4, ...be16(4), 0, 0],
    ...[0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    ...[0xff, 0xd9],
  ]);
}

export function gifBytes({ width, height }: { width: number; height: number }): Uint8Array {
  return new Uint8Array([...chars('GIF89a'), ...le16(width), ...le16(height), 0, 0, 0]);
}

function riff(chunk: number[]): Uint8Array {
  const size = 4 + chunk.length;
  return new Uint8Array([...chars('RIFF'), size & 0xff, (size >> 8) & 0xff, 0, 0, ...chars('WEBP'), ...chunk]);
}

export function webpLossyBytes({ width, height }: { width: number; height: number }): Uint8Array {
  return riff([...chars('VP8 '), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0]);
}

export function webpLosslessBytes({ width, height }: { width: number; height: number }): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return riff([
    ...chars('VP8L'),
    0,
    0,
    0,
    0,
    0x2f,
    bits & 0xff,
    (bits >> 8) & 0xff,
    (bits >> 16) & 0xff,
    (bits >>> 24) & 0xff,
    0,
    0,
    0,
    0,
    0,
  ]);
}

export function webpExtendedBytes({ width, height }: { width: number; height: number }): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return riff([
    ...chars('VP8X'),
    10,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    w & 0xff,
    (w >> 8) & 0xff,
    (w >> 16) & 0xff,
    h & 0xff,
    (h >> 8) & 0xff,
    (h >> 16) & 0xff,
  ]);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
