// Types of scripts/image-metadata.mjs (plain JavaScript, so that strip-exif.mjs can run without a build step).

export type ImageContainer = 'jpeg' | 'png' | 'webp' | 'gif' | 'heif' | 'tiff' | 'video';

/** The container format, from the magic bytes; undefined when the bytes are not an image or video it knows. */
export function sniffImage(bytes: Uint8Array): ImageContainer | undefined;

/** The metadata carriers found in an encoded image; an empty list means clean. `kind` defaults to sniffImage(bytes). */
export function findMetadata(bytes: Uint8Array, kind?: ImageContainer): string[];
