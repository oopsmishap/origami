function fnv1a(str: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function contentHash(content: string): string {
  return fnv1a(content, 0x811c9dc5) + fnv1a(content, 0x1b873593);
}