/** File-picker `accept` for the images we can read, iPhone HEIC photos included. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic,image/heif,.heic,.heif';

/** HEIC / HEIF (iPhone photos). Some browsers report no MIME type for them, so check the name too. */
export function isHeicFile(f: File): boolean {
  return /^image\/hei[cf]/.test(f.type) || /\.hei[cf]$/i.test(f.name);
}

/** A raster image we may be able to decode (SVG is handled elsewhere). */
export function isRasterFile(f: File): boolean {
  return (f.type.startsWith('image/') && f.type !== 'image/svg+xml') || isHeicFile(f);
}

/**
 * Decode an image file, upright (EXIF orientation applied). Browsers that cannot read
 * HEIC natively fall back to a decoder that is only downloaded when it is needed.
 */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    if (!(file instanceof File && isHeicFile(file))) throw new Error('Could not read that image');
    try {
      const { heicTo } = await import('heic-to');
      return await heicTo({ blob: file, type: 'bitmap', options: { imageOrientation: 'from-image' } });
    } catch {
      throw new Error('Could not read that HEIC photo. Try exporting it as JPG.');
    }
  }
}
