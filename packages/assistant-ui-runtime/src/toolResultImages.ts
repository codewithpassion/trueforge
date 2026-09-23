import type { ToolImageContentPart } from './server/index.js';

/** Carried on a tool-call part's `artifact`, since assistant-ui's `result` holds the text only. */
export interface ToolResultImagesArtifact {
  toolImages: ToolImageContentPart[];
}

function isToolImagePart(value: unknown): value is ToolImageContentPart {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'type') === 'image' &&
    typeof Reflect.get(value, 'fileId') === 'string' &&
    typeof Reflect.get(value, 'mediaType') === 'string' &&
    typeof Reflect.get(value, 'width') === 'number' &&
    typeof Reflect.get(value, 'height') === 'number'
  );
}

/** The images a tool returned, read from a tool-call part; empty when it returned none. */
export function getToolResultImages(part: { artifact?: unknown }): ToolImageContentPart[] {
  const { artifact } = part;
  if (typeof artifact !== 'object' || artifact === null) {
    return [];
  }
  const images: unknown = Reflect.get(artifact, 'toolImages');
  return Array.isArray(images) ? images.filter(isToolImagePart) : [];
}
