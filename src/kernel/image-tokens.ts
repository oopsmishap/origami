export interface ImageDims {
  w: number;
  h: number;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];

function pngDims(b: Uint8Array): ImageDims | undefined {
  if (b.length < 24 || !PNG_SIG.every((v, i) => b[i] === v)) return undefined;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = view.getUint32(16, false);
  const h = view.getUint32(20, false);
  return w > 0 && h > 0 ? { w, h } : undefined;
}

function gifDims(b: Uint8Array): ImageDims | undefined {
  if (b.length < 10 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return undefined;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = view.getUint16(6, true);
  const h = view.getUint16(8, true);
  return w > 0 && h > 0 ? { w, h } : undefined;
}

function bmpDims(b: Uint8Array): ImageDims | undefined {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return undefined;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = view.getUint32(18, true);
  const h = Math.abs(view.getInt32(22, true));
  return w > 0 && h > 0 ? { w, h } : undefined;
}

function jpegDims(b: Uint8Array): ImageDims | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) {
      off += 1;
      continue;
    }
    const marker = b[off + 1];
    if (marker === undefined) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      off += 2;
      continue;
    }
    if (marker === 0xda) break;
    const segLen = view.getUint16(off + 2, false);
    if (segLen < 2) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (off + 9 > b.length) break;
      const h = view.getUint16(off + 5, false);
      const w = view.getUint16(off + 7, false);
      if (w > 0 && h > 0) return { w, h };
      break;
    }
    off += 2 + segLen;
  }
  return undefined;
}

export function decodeImageDims(b64: string): ImageDims | undefined {
  try {
    const head = Buffer.from(b64.slice(0, 64), "base64");
    for (const parse of [pngDims, gifDims, bmpDims]) {
      const d = parse(head);
      if (d) return d;
    }
    if (head.length >= 2 && head[0] === 0xff && head[1] === 0xd8) {
      return jpegDims(Buffer.from(b64.slice(0, 350_000), "base64"));
    }
  } catch {
    /* malformed base64 */
  }
  return undefined;
}

const TILE_EDGE = 512;
const TILE_SHORT_SIDE = 768;
const TILE_MAX_EDGE = 2048;

/**
 * Default fallback token count for unparsable or remote images (~1 tile).
 * Matches OpenAI / Anthropic single-tile minimum.
 */
export const DEFAULT_IMAGE_TOKENS = 1600;

/**
 * Standard OpenAI / Anthropic high-detail vision tile model (Billion-Context #488, #767, #1843).
 * 1. Short side scaled up to 768px.
 * 2. Long side capped at 2048px.
 * 3. 512x512px tiles @ 170 tokens/tile + 85 base tokens.
 */
export function pixelTileEstimate(w: number, h: number): number {
  let sw = w;
  let sh = h;
  const shortSide = Math.min(sw, sh);
  if (shortSide > 0 && shortSide < TILE_SHORT_SIDE) {
    const s = TILE_SHORT_SIDE / shortSide;
    sw *= s;
    sh *= s;
  }
  const longSide = Math.max(sw, sh);
  if (longSide > TILE_MAX_EDGE) {
    const s = TILE_MAX_EDGE / longSide;
    sw *= s;
    sh *= s;
  }
  const tiles = Math.ceil(sw / TILE_EDGE) * Math.ceil(sh / TILE_EDGE);
  return 85 + 170 * tiles;
}

/**
 * Estimate realistic vision token usage from a message content block.
 * Recognizes inline base64 images (PNG, JPEG, GIF, BMP, WebP), Anthropic source blocks,
 * and OpenAI image_url structures.
 */
export function estimateImageBlockTokens(block: unknown): number {
  if (!block || typeof block !== "object") return 0;
  const b = block as Record<string, unknown>;
  const type = String(b.type ?? "");
  if (type !== "image" && type !== "image_url") return 0;

  let b64: string | undefined;

  if (typeof b.data === "string") {
    b64 = b.data;
  } else if (b.source && typeof b.source === "object" && typeof (b.source as Record<string, unknown>).data === "string") {
    b64 = (b.source as Record<string, unknown>).data as string;
  } else if (typeof b.url === "string") {
    const u = b.url;
    if (u.startsWith("data:") && u.includes(";base64,")) {
      b64 = u.slice(u.indexOf(";base64,") + 8);
    } else {
      return DEFAULT_IMAGE_TOKENS;
    }
  } else if (b.image_url && typeof b.image_url === "object" && typeof (b.image_url as Record<string, unknown>).url === "string") {
    const u = (b.image_url as Record<string, unknown>).url as string;
    if (u.startsWith("data:") && u.includes(";base64,")) {
      b64 = u.slice(u.indexOf(";base64,") + 8);
    } else {
      return DEFAULT_IMAGE_TOKENS;
    }
  }

  if (!b64) return DEFAULT_IMAGE_TOKENS;

  const dims = decodeImageDims(b64);
  if (dims) {
    return pixelTileEstimate(dims.w, dims.h);
  }
  return DEFAULT_IMAGE_TOKENS;
}
