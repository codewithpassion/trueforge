/**
 * Copies into a standalone ArrayBuffer for a response body: a pooled Buffer's
 * backing store is shared and typed as ArrayBufferLike, which is not a body.
 */
export function toArrayBuffer(content: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(content.byteLength);
  new Uint8Array(buffer).set(content);
  return buffer;
}
