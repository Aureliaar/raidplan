const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const SERVER_MAX_DIMENSION = 8192;
const RESIZED_MAX_DIMENSION = 4096;

export type PreparedBackground = {
  file: File;
  resized: boolean;
  originalWidth: number;
  originalHeight: number;
};

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("This browser could not resize the image"))),
      "image/webp",
      quality
    );
  });
}

/**
 * Keep ordinary uploads byte-for-byte intact. Images beyond either server
 * limit are rasterized locally to WebP, saving bandwidth and KV space.
 */
export async function prepareBackground(file: File): Promise<PreparedBackground> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error("Choose an image smaller than 50 MiB");

  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error("Use a valid PNG, JPEG, or WebP image");
  }

  const originalWidth = image.width;
  const originalHeight = image.height;
  const needsResize =
    file.size > MAX_UPLOAD_BYTES ||
    originalWidth > SERVER_MAX_DIMENSION ||
    originalHeight > SERVER_MAX_DIMENSION;
  if (!needsResize) {
    image.close();
    return { file, resized: false, originalWidth, originalHeight };
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    image.close();
    throw new Error("This browser could not resize the image");
  }

  let scale = Math.min(1, RESIZED_MAX_DIMENSION / Math.max(originalWidth, originalHeight));
  let quality = 0.9;
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      canvas.width = Math.max(1, Math.round(originalWidth * scale));
      canvas.height = Math.max(1, Math.round(originalHeight * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas, quality);
      if (blob.size <= MAX_UPLOAD_BYTES) {
        const stem = file.name.replace(/\.[^.]+$/, "") || "background";
        return {
          file: new File([blob], `${stem}.webp`, { type: "image/webp" }),
          resized: true,
          originalWidth,
          originalHeight,
        };
      }
      if (quality > 0.66) quality -= 0.12;
      else scale *= 0.8;
    }
  } finally {
    image.close();
  }

  throw new Error("The image is still larger than 5 MiB after downscaling");
}
