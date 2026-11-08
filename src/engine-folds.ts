import type { EngineContext } from "./engine-types.ts";
import { extractManifest } from "./kernel/manifest.ts";
import type { BoundMessage, RefRange } from "./kernel/types.ts";
import { parseRef } from "./kernel/types.ts";

export function archiveDigest(
  context: Readonly<EngineContext>,
  ranges: readonly RefRange[],
  perMessageChars = 160,
  maxChars = 4800,
): string {
  const matched: BoundMessage[] = [];
  for (const message of context.state.bound) {
    if (message.ephemeral) continue;
    const number = parseRef(message.ref);
    if (!ranges.some((range) => number >= parseRef(range.start) && number <= parseRef(range.end))) continue;
    matched.push(message);
  }
  if (matched.length === 0) return "";

  const formatLine = (message: BoundMessage): string => {
    const flat = message.text.replace(/\s+/g, " ").trim();
    const clipped = flat.length > perMessageChars ? `${flat.slice(0, perMessageChars - 1)}…` : flat;
    return `[#${message.ref}] ${message.role}: ${clipped}`;
  };

  const maxLines = Math.max(12, Math.floor(maxChars / Math.max(40, Math.min(perMessageChars, 120))));
  const manifest = extractManifest(matched);
  const manifestParts: string[] = [];
  if (manifest.paths.length > 0) manifestParts.push(`Paths: ${manifest.paths.slice(0, 12).join(", ")}`);
  if (manifest.commits.length > 0) manifestParts.push(`Commits: ${manifest.commits.slice(0, 8).join(", ")}`);
  if (manifest.errors.length > 0) manifestParts.push(`Errors: ${manifest.errors.slice(0, 4).join("; ")}`);
  const footer = manifestParts.length > 0 ? manifestParts.join("\n").slice(0, 600) : "";
  const bodyBudget = Math.max(400, maxChars - (footer ? footer.length + 2 : 0));

  let selected = matched;
  let elidedCount = 0;
  if (matched.length > maxLines) {
    const headCount = Math.min(8, Math.floor(maxLines / 3));
    const tailCount = Math.min(8, Math.floor(maxLines / 3));
    const midBudget = Math.max(2, maxLines - headCount - tailCount);
    const middlePool = matched.slice(headCount, matched.length - tailCount);
    const userMiddle = middlePool.filter((m) => m.role === "user");
    const sampleSource = userMiddle.length >= midBudget ? userMiddle : middlePool;
    const sampledMid: BoundMessage[] = [];
    const step = sampleSource.length / midBudget;
    for (let i = 0; i < midBudget && i < sampleSource.length; i++) {
      sampledMid.push(sampleSource[Math.min(sampleSource.length - 1, Math.floor(i * step))]!);
    }
    selected = [
      ...matched.slice(0, headCount),
      ...sampledMid,
      ...matched.slice(matched.length - tailCount),
    ];
    elidedCount = matched.length - selected.length;
  }

  const lines: string[] = [];
  let usedChars = 0;
  const headMarkerIdx = elidedCount > 0 ? Math.min(8, Math.floor(maxLines / 3)) : -1;
  for (let i = 0; i < selected.length; i++) {
    if (i === headMarkerIdx) {
      const marker = `[… ${elidedCount} intermediate messages archived; query via fold_search / fold_recall …]`;
      if (usedChars + marker.length + 1 <= bodyBudget) {
        lines.push(marker);
        usedChars += marker.length + 1;
      }
    }
    const line = formatLine(selected[i]!);
    if (lines.length > 0 && usedChars + line.length + 1 > bodyBudget) {
      const remaining = matched.length - lines.length;
      if (remaining > 0 && elidedCount === 0) {
        const tailMarker = `[… ${remaining} more messages archived; query via fold_search / fold_recall …]`;
        if (usedChars + tailMarker.length + 1 <= maxChars) lines.push(tailMarker);
      }
      break;
    }
    lines.push(line);
    usedChars += line.length + 1;
  }

  if (footer) lines.push(footer);
  return lines.join("\n");
}
