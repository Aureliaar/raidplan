import type { AppEnv } from "./env";

export const BACKGROUND_MAX_BYTES = 5 * 1024 * 1024;
export const BACKGROUND_MAX_DIMENSION = 8192;

type ImageInfo = {
  contentType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
  width: number;
  height: number;
};

type BackgroundMetadata = {
  contentType: ImageInfo["contentType"];
  ownerId: string;
  width: number;
  height: number;
};

export class BackgroundUploadError extends Error {
  constructor(
    public status: 400 | 413 | 415,
    message: string
  ) {
    super(message);
  }
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) return null;
    if (offset + 2 > bytes.length) return null;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 7) return null;
      return { height: u16be(bytes, offset + 3), width: u16be(bytes, offset + 5) };
    }
    offset += length;
  }
  return null;
}

function imageInfo(bytes: Uint8Array): ImageInfo | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    ascii(bytes, 12, 4) === "IHDR"
  ) {
    return { contentType: "image/png", extension: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }

  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const dimensions = jpegDimensions(bytes);
    return dimensions ? { contentType: "image/jpeg", extension: "jpg", ...dimensions } : null;
  }

  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const kind = ascii(bytes, 12, 4);
    if (kind === "VP8X") {
      return {
        contentType: "image/webp",
        extension: "webp",
        width: u24le(bytes, 24) + 1,
        height: u24le(bytes, 27) + 1,
      };
    }
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = new DataView(bytes.buffer, bytes.byteOffset + 21, 4).getUint32(0, true);
      return {
        contentType: "image/webp",
        extension: "webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        contentType: "image/webp",
        extension: "webp",
        width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
        height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
      };
    }
  }

  return null;
}

export async function uploadBackground(
  request: Request,
  env: AppEnv,
  userId: string
): Promise<{ url: string; width: number; height: number }> {
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > BACKGROUND_MAX_BYTES) {
    throw new BackgroundUploadError(413, "Backgrounds must be 5 MiB or smaller");
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) throw new BackgroundUploadError(400, "Choose an image to upload");
  if (bytes.length > BACKGROUND_MAX_BYTES) {
    throw new BackgroundUploadError(413, "Backgrounds must be 5 MiB or smaller");
  }

  const info = imageInfo(bytes);
  if (!info) throw new BackgroundUploadError(415, "Use a valid PNG, JPEG, or WebP image");
  if (
    info.width < 1 ||
    info.height < 1 ||
    info.width > BACKGROUND_MAX_DIMENSION ||
    info.height > BACKGROUND_MAX_DIMENSION
  ) {
    throw new BackgroundUploadError(400, "Background dimensions must be at most 8192 × 8192");
  }

  const name = `${crypto.randomUUID()}.${info.extension}`;
  const key = `backgrounds/${name}`;
  await env.BACKGROUNDS.put(key, bytes, {
    metadata: {
      contentType: info.contentType,
      ownerId: userId,
      width: info.width,
      height: info.height,
    },
  });

  return { url: `/backgrounds/${name}`, width: info.width, height: info.height };
}

export async function serveBackground(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext
): Promise<Response> {
  // Query strings do not identify a different immutable image. Keeping them out
  // of the cache key prevents an attacker manufacturing a cache miss per query.
  const canonicalUrl = new URL(request.url);
  canonicalUrl.search = "";
  const cacheRequest = new Request(canonicalUrl, { method: "GET" });
  const cache = await caches.open("raidplan-backgrounds");
  const cached = await cache.match(cacheRequest);
  if (cached) return cached;

  const name = canonicalUrl.pathname.slice("/backgrounds/".length);
  if (!/^[0-9a-f-]{36}\.(?:jpg|png|webp)$/.test(name)) return new Response("Not found", { status: 404 });

  const etag = `"${name.slice(0, 36)}"`;
  const headers = new Headers({
    "cache-control": "public, max-age=31536000, immutable",
    "etag": etag,
    "x-content-type-options": "nosniff",
  });
  if (request.headers.get("if-none-match")?.split(",").some((value) => value.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }

  const stored = await env.BACKGROUNDS.getWithMetadata<BackgroundMetadata>(`backgrounds/${name}`, {
    type: "stream",
    cacheTtl: 86400,
  });
  if (!stored.value || !stored.metadata) return new Response("Not found", { status: 404 });

  headers.set("content-type", stored.metadata.contentType);
  const response = new Response(stored.value, { headers });
  ctx.waitUntil(cache.put(cacheRequest, response.clone()));
  return response;
}
