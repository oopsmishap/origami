import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { kv, md, text } from "@oh-my-pi/pi-tui/native/describe";
import { escCloseButton, hintsRow, itemIndex, overlayCard, selectList } from "@oh-my-pi/pi-tui/native/overlay";
import { describeSegmentTrack, renderSegmentTrack } from "@oh-my-pi/pi-tui/chrome/segment-track";
import { OverlayPanel } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import type { WorkbenchModel, WorkbenchActions, WorkbenchKeyOutcome } from "./workbench-model.ts";
import { WORKBENCH_TABS, handleWorkbenchKey, workbenchLines } from "./workbench-model.ts";
import { formatTokens } from "../kernel/nudge.ts";

export class WorkbenchComponent implements Component {
  readonly nativeOverlay = {
    role: "omp.overlay.origami",
    head: "origami fold workbench",
    size: "lg" as const,
    anchor: "center" as const,
  };

  private model: WorkbenchModel;
  private actions: WorkbenchActions;
  private tui: TUI;
  private onOutcome: (outcome: WorkbenchKeyOutcome) => void;

  constructor(opts: {
    model: WorkbenchModel;
    actions: WorkbenchActions;
    tui: TUI;
    onOutcome: (outcome: WorkbenchKeyOutcome) => void;
  }) {
    this.model = opts.model;
    this.actions = opts.actions;
    this.tui = opts.tui;
    this.onOutcome = opts.onOutcome;
  }

  render(width: number): readonly string[] {
    const panel = new OverlayPanel("origami fold workbench", "omp.overlay.origami");
    const track = renderSegmentTrack(
      WORKBENCH_TABS.map((label) => ({ label })),
      this.model.tab,
    );
    for (const line of [track, "", ...workbenchLines(this.model)]) panel.addChild(makeText(line));
    return panel.render(width);
  }

  describe(_cx: DescribeContext): NativeNode | null {
    const track = describeSegmentTrack(
      WORKBENCH_TABS.map((label) => ({ label })),
      this.model.tab,
    );
    return overlayCard("omp.overlay.origami", "origami fold workbench", [
      track,
      this.tabBody(),
      hintsRow([
        { keys: ["left", "right"], label: "tab" },
        { keys: ["up", "down"], label: "select" },
        { keys: ["f"], label: "fold preview" },
        { keys: ["u"], label: "unfold" },
        { keys: ["enter"], label: "drill" },
        { keys: ["esc"], label: "close" },
      ]),
      escCloseButton("close"),
    ]);
  }

  private tabBody(): NativeNode {
    const m = this.model;
    if (m.tab === 0) {
      const items = m.blocks.map((b, i) =>
        text(
          `${i === m.selected ? "▶ " : "  "}${b.id}  tier ${b.tier}  ${b.coverage}  ${formatTokens(b.tokens)}  ` +
            `${b.topic}${b.superseded ? " (superseded)" : ""}`,
          { key: `block${i}` },
        ),
      );
      return selectList("blocks", items.length > 0 ? items : [text("(no fold blocks yet)")], { selected: `block${m.selected}` });
    }
    if (m.tab === 1) {
      const pairs: [string, string][] = [];
      for (const r of m.rounds) {
        pairs.push([
          new Date(r.ts).toISOString().slice(11, 19),
          `in ${r.totalIn} · read ${r.cacheRead} · write ${r.cacheWrite}${r.foldEventId ? ` · ${r.foldEventId}` : ""}`,
        ]);
      }
      if (pairs.length === 0) pairs.push(["rounds", "(none recorded yet)"]);
      return kv(pairs) ?? text("(no cache data)");
    }
    const lines = m.zones.map((z) => `${z.kind.padEnd(12)} ${z.start}..${z.end}`);
    return md(lines.length > 0 ? lines.join("\n") : "(no zones)");
  }

  handleInput(data: string): void {
    const outcome = handleWorkbenchKey(this.model, data, {
      model: () => this.model,
      previewFold: () => this.actions.previewFold(),
      unfoldSelected: (id) => this.actions.unfoldSelected(id),
      drill: (id) => this.actions.drill(id),
    });
    if (outcome.handled) this.onOutcome(outcome);
    this.tui.requestRender();
  }

  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "select") {
      const idx = itemIndex(event.item, "block");
      if (idx >= 0) {
        this.model.selected = idx;
        this.tui.requestRender();
      }
      return;
    }
    if (event.type === "action") {
      if (event.act === "close") {
        this.onOutcome({ handled: true, close: true });
      } else if (event.act === "tab" && event.value) {
        const tab = WORKBENCH_TABS.findIndex((t) => t === event.value);
        if (tab >= 0) this.model.tab = tab;
      } else if (event.act === "fold-preview") {
        this.onOutcome({ handled: true, message: this.actions.previewFold().join("\n") });
      } else if (event.act === "unfold") {
        const block = this.model.blocks[this.model.selected];
        if (block) void this.actions.unfoldSelected(block.id).then((msg) => this.onOutcome({ handled: true, message: msg }));
      } else if (event.act === "drill") {
        const block = this.model.blocks[this.model.selected];
        if (block) this.onOutcome({ handled: true, message: this.actions.drill(block.id).join("\n") });
      }
      this.tui.requestRender();
    }
  }

  capturesInput(data: string): boolean {
    return (
      data === "\x1b" ||
      data === "q" ||
      data === "f" ||
      data === "u" ||
      data === "\r" ||
      data === "\n" ||
      data === "\t" ||
      data.startsWith("\x1b[")
    );
  }
}

function makeText(line: string): Component {
  return {
    render: () => [line],
  };
}