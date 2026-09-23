import { readImageHeader } from '../../../src/core/files/imageHeader';
import { gifBytes, jpegBytes, pngBytes, webpExtendedBytes, webpLosslessBytes, webpLossyBytes } from './imageFixtures';

describe('readImageHeader', () => {
  it.each([
    ['image/png', pngBytes],
    ['image/jpeg', jpegBytes],
    ['image/gif', gifBytes],
    ['image/webp', webpLossyBytes],
    ['image/webp', webpLosslessBytes],
    ['image/webp', webpExtendedBytes],
  ] as const)('reads %s size from the header', (mediaType, build) => {
    expect(readImageHeader(build({ width: 1280, height: 800 }))).toEqual({
      media_type: mediaType,
      width: 1280,
      height: 800,
    });
  });

  it('reads the frame size of a JPEG whose SOF comes after other segments', () => {
    expect(readImageHeader(jpegBytes({ width: 3, height: 7000 }))).toEqual({
      media_type: 'image/jpeg',
      width: 3,
      height: 7000,
    });
  });

  it('rejects a JPEG with no frame header', () => {
    expect(readImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xd9]))).toBeUndefined();
  });

  it('rejects a truncated header', () => {
    expect(readImageHeader(pngBytes({ width: 10, height: 10 }).slice(0, 20))).toBeUndefined();
    expect(readImageHeader(webpExtendedBytes({ width: 10, height: 10 }).slice(0, 26))).toBeUndefined();
  });

  it('rejects a zero size', () => {
    expect(readImageHeader(pngBytes({ width: 0, height: 10 }))).toBeUndefined();
    expect(readImageHeader(gifBytes({ width: 10, height: 0 }))).toBeUndefined();
  });

  it('rejects other formats', () => {
    expect(readImageHeader(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(readImageHeader(new Uint8Array())).toBeUndefined();
  });

  it('reads a header from a view into a larger buffer', () => {
    const png = pngBytes({ width: 5, height: 6 });
    const padded = new Uint8Array(png.length + 7);
    padded.set(png, 7);
    expect(readImageHeader(padded.subarray(7))).toEqual({ media_type: 'image/png', width: 5, height: 6 });
  });
});
