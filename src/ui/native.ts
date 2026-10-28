/**
 * Optional native (Tern) UI bindings. Older oh-my-pi hosts ship only the ANSI
 * TUI; their `@oh-my-pi/pi-tui` lacks the native modules, so importing them
 * statically would stop the whole extension from loading. Everything native is
 * reached through this module and skipped when the host cannot provide it.
 */
import type * as DescribeModule from "@oh-my-pi/pi-tui/native/describe";
import type * as MemoModule from "@oh-my-pi/pi-tui/native/memo";
import type * as NodeModule from "@oh-my-pi/pi-tui/native/node";
import type * as OverlayModule from "@oh-my-pi/pi-tui/native/overlay";
import type * as SpansModule from "@oh-my-pi/pi-tui/native/spans";
import type * as ToolViewModule from "@oh-my-pi/pi-tui/tools/native-view";

interface NativeUi {
  describe: typeof DescribeModule;
  memo: typeof MemoModule;
  node: typeof NodeModule;
  overlay: typeof OverlayModule;
  spans: typeof SpansModule;
  toolView: typeof ToolViewModule;
}

async function loadNativeUi(): Promise<NativeUi | null> {
  try {
    const [describe, memo, node, overlay, spans, toolView] = await Promise.all([
      import("@oh-my-pi/pi-tui/native/describe"),
      import("@oh-my-pi/pi-tui/native/memo"),
      import("@oh-my-pi/pi-tui/native/node"),
      import("@oh-my-pi/pi-tui/native/overlay"),
      import("@oh-my-pi/pi-tui/native/spans"),
      import("@oh-my-pi/pi-tui/tools/native-view"),
    ]);
    return { describe, memo, node, overlay, spans, toolView };
  } catch {
    return null;
  }
}

const ui = await loadNativeUi();

/** True when the host can render native (Tern) surfaces. */
export const nativeAvailable = ui !== null;

function need(): NativeUi {
  if (!ui) throw new Error("origami: native UI is unavailable on this oh-my-pi version");
  return ui;
}

type AnyFn = (...args: unknown[]) => unknown;

// Delegates are only reached from `describe*` paths, which are gated on `nativeAvailable`.
export const item = ((...a: unknown[]) => (need().describe.item as AnyFn)(...a)) as typeof DescribeModule.item;
export const kv = ((...a: unknown[]) => (need().describe.kv as AnyFn)(...a)) as typeof DescribeModule.kv;
export const list = ((...a: unknown[]) => (need().describe.list as AnyFn)(...a)) as typeof DescribeModule.list;
export const md = ((...a: unknown[]) => (need().describe.md as AnyFn)(...a)) as typeof DescribeModule.md;
export const node = ((...a: unknown[]) => (need().describe.node as AnyFn)(...a)) as typeof DescribeModule.node;
export const row = ((...a: unknown[]) => (need().describe.row as AnyFn)(...a)) as typeof DescribeModule.row;
export const span = ((...a: unknown[]) => (need().describe.span as AnyFn)(...a)) as typeof DescribeModule.span;
export const text = ((...a: unknown[]) => (need().describe.text as AnyFn)(...a)) as typeof DescribeModule.text;
export const rootToggleExpanded = ((...a: unknown[]) => (need().node.rootToggleExpanded as AnyFn)(...a)) as typeof NodeModule.rootToggleExpanded;
export const actionBar = ((...a: unknown[]) => (need().overlay.actionBar as AnyFn)(...a)) as typeof OverlayModule.actionBar;
export const actionButton = ((...a: unknown[]) => (need().overlay.actionButton as AnyFn)(...a)) as typeof OverlayModule.actionButton;
export const hintsRow = ((...a: unknown[]) => (need().overlay.hintsRow as AnyFn)(...a)) as typeof OverlayModule.hintsRow;
export const itemIndex = ((...a: unknown[]) => (need().overlay.itemIndex as AnyFn)(...a)) as typeof OverlayModule.itemIndex;
export const overlayCard = ((...a: unknown[]) => (need().overlay.overlayCard as AnyFn)(...a)) as typeof OverlayModule.overlayCard;
export const selectList = ((...a: unknown[]) => (need().overlay.selectList as AnyFn)(...a)) as typeof OverlayModule.selectList;
export const errorView = ((...a: unknown[]) => (need().toolView.errorView as AnyFn)(...a)) as typeof ToolViewModule.errorView;
export const toolHead = ((...a: unknown[]) => (need().toolView.toolHead as AnyFn)(...a)) as typeof ToolViewModule.toolHead;

export function createMemo(): MemoModule.Memo {
  return new (need().memo.Memo)();
}

export function createOwnerMemo<T>(): MemoModule.OwnerMemo<T> {
  return new (need().memo.OwnerMemo)<T>();
}

const ESCAPE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Visible characters of ANSI-styled text; the host's sanitizer when available. */
export function plainText(styled: string): string {
  if (ui) return ui.spans.plainText(styled);
  return styled.includes("\x1b") ? styled.replace(ESCAPE_PATTERN, "") : styled;
}

/** Text blocks of a tool result joined by newlines. */
export function resultText(result: { content?: readonly { type: string; text?: unknown }[] }): string {
  let out = "";
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") out += out ? `\n${block.text}` : block.text;
  }
  return out;
}
