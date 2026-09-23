'use client';

import { useEffect, useState } from 'react';

import type { ToolImageContentPart } from '../server/types.js';
import { useSlot } from '../theme/SlotsProvider.js';

export type ToolResultThumbnailsProps = {
  images: ToolImageContentPart[];
  /** Reads a stored image; without it the images are only named. */
  loadImage?: (fileId: string) => Promise<Blob>;
};

type Loaded = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'failed' };

function ToolResultThumbnail({
  image,
  loadImage,
  index,
}: {
  image: ToolImageContentPart;
  loadImage: ((fileId: string) => Promise<Blob>) | undefined;
  index: number;
}) {
  const AttachmentPreviewDialog = useSlot('AttachmentPreviewDialog');
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });

  useEffect(() => {
    if (loadImage === undefined) {
      setLoaded({ status: 'failed' });
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    setLoaded({ status: 'loading' });
    loadImage(image.fileId).then(
      blob => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setLoaded({ status: 'ready', url });
      },
      () => {
        if (!cancelled) setLoaded({ status: 'failed' });
      },
    );
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [image.fileId, loadImage]);

  const label = `Screenshot ${String(index + 1)} (${String(image.width)}×${String(image.height)})`;
  const aspectRatio =
    image.width > 0 && image.height > 0 ? `${String(image.width)} / ${String(image.height)}` : undefined;

  if (loaded.status !== 'ready') {
    return (
      <div
        role={loaded.status === 'failed' ? 'img' : 'status'}
        aria-label={loaded.status === 'failed' ? `${label} unavailable` : `Loading ${label}`}
        className="flex w-48 items-center justify-center rounded-md border border-border bg-secondary-bg text-xs text-text-secondary"
        style={{ aspectRatio }}
      >
        {loaded.status === 'failed' ? 'Image unavailable' : null}
      </div>
    );
  }
  return (
    <AttachmentPreviewDialog previewSrc={loaded.url}>
      <img
        src={loaded.url}
        alt={label}
        className="block w-48 rounded-md border border-border object-contain"
        style={{ aspectRatio }}
      />
    </AttachmentPreviewDialog>
  );
}

/** Thumbnails of the images a tool returned; click one to see it full size. */
export function ToolResultThumbnails({ images, loadImage }: ToolResultThumbnailsProps) {
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 py-1.5" data-testid="tool-result-thumbnails">
      {images.map((image, index) => (
        <ToolResultThumbnail key={image.fileId} image={image} loadImage={loadImage} index={index} />
      ))}
    </div>
  );
}

declare module '../theme/SlotsProvider.js' {
  interface AtomSlots {
    ToolResultThumbnails: typeof ToolResultThumbnails;
  }
}
