import type * as acp from "@agentclientprotocol/sdk";
import type { Disposable } from "atom";

export interface ToolView {
  element: HTMLElement;
  heading: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
  summary: HTMLElement;
  toggle: HTMLButtonElement;
  expanded: boolean;
  collapsible: boolean;
  diff: boolean;
  location: acp.ToolCallLocation | null;
  locationTooltip: Disposable | null;
}

export type ToolUpdate = {
  toolCallId: string;
  status?: acp.ToolCallStatus;
  title?: string;
  kind?: acp.ToolKind;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: acp.ToolCallContent[];
  locations?: acp.ToolCallLocation[];
};

export interface ToolCallHost {
  openLocation: (path: string, line?: number) => Promise<void>;
  scheduleFollow?: (path: string, line?: number | null) => void;
  followAgent?: boolean;
  addTooltipDisposable: (d: Disposable) => void;
  onBeforeNewToolCall?: () => void;
  scrollToBottom: () => void;
  renderToolContent?: (item: acp.ToolCallContent) => HTMLElement;
  makeButton?: (label: string, onClick: () => void) => HTMLButtonElement;
}

function rawOutputText(update: ToolUpdate): string | null {
  const raw = update.rawOutput;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const candidate = (raw as { output?: unknown }).output;
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function summarizeToolUpdate(update: ToolUpdate): string {
  const text = rawOutputText(update);
  if (text !== null) {
    const clean = text.trim();
    if (!clean) return "";
    const lines = clean.split(/\r?\n/).filter(Boolean);
    const title = update.title ?? "";
    if (title.startsWith("Grep")) {
      return `${lines.length} results`;
    }
    if (title.startsWith("Glob")) {
      return `${lines.length} files`;
    }
    if (title.startsWith("List")) {
      return `${lines.length} entries`;
    }
    if (title.startsWith("Test")) {
      return `${lines.length} lines`;
    }
    return lines[0];
  }

  const content = update.content;
  if (content && content.length > 0 && content[0].type === "diff") {
    return `Diff for ${content[0].path}`;
  }
  return "";
}

function setCollapsed(view: ToolView, collapsed: boolean): void {
  view.expanded = !collapsed;
  view.body.classList.toggle(
    "pulsar-assistant-tool-body--collapsed",
    collapsed,
  );
  view.body.classList.toggle(
    "pulsar-assistant-tool-body--expanded",
    !collapsed,
  );
  view.toggle.textContent = collapsed ? "Show more" : "Show less";
}

export class ToolCallManager {
  private toolViews = new Map<string, ToolView>();
  private host: ToolCallHost;

  constructor(host: ToolCallHost) {
    this.host = host;
  }

  getToolView(id: string): ToolView | undefined {
    return this.toolViews.get(id);
  }

  clear(): void {
    for (const view of this.toolViews.values()) {
      view.locationTooltip?.dispose();
    }
    this.toolViews.clear();
  }

  renderToolContent(item: acp.ToolCallContent): HTMLElement {
    if (item.type === "content") {
      const block = item.content;
      if (block.type === "text") {
        const p = document.createElement("div");
        p.classList.add("pulsar-assistant-tool-text");
        p.textContent = block.text;
        return p;
      }
      const pre = document.createElement("pre");
      pre.classList.add("pulsar-assistant-code-block");
      pre.textContent = JSON.stringify(block, null, 2);
      return pre;
    }
    if (item.type === "diff") {
      const diffEl = document.createElement("pre");
      diffEl.classList.add("pulsar-assistant-diff");
      diffEl.textContent = item.newText;
      return diffEl;
    }
    const pre = document.createElement("pre");
    pre.classList.add("pulsar-assistant-code-block");
    pre.textContent = JSON.stringify(item, null, 2);
    return pre;
  }

  renderToolCall(
    container: HTMLElement,
    toolCall: acp.ToolCall | ToolUpdate,
  ): HTMLElement {
    const existing = this.toolViews.get(toolCall.toolCallId);
    if (existing) {
      this.updateToolView(toolCall.toolCallId, toolCall);
      return existing.element;
    }

    this.host.onBeforeNewToolCall?.();

    const block = document.createElement("div");
    block.classList.add("pulsar-assistant-tool-call");
    block.dataset.toolCallId = toolCall.toolCallId;
    if (toolCall.kind) block.dataset.kind = toolCall.kind;

    const heading = document.createElement("div");
    heading.classList.add("pulsar-assistant-tool-heading");

    const title = document.createElement("span");
    title.classList.add("pulsar-assistant-tool-title");
    title.textContent = toolCall.title || "Tool Call";

    const status = document.createElement("span");
    status.classList.add("pulsar-assistant-tool-status");
    status.textContent = toolCall.status || "pending";

    const summary = document.createElement("div");
    summary.classList.add("pulsar-assistant-tool-summary");
    summary.style.display = "none";

    const toggle = document.createElement("button");
    toggle.classList.add("pulsar-assistant-tool-toggle");
    toggle.textContent = "Show more";
    toggle.style.display = "none";

    heading.appendChild(title);
    heading.appendChild(status);
    heading.appendChild(summary);
    block.appendChild(heading);
    block.appendChild(toggle);

    const body = document.createElement("div");
    body.classList.add(
      "pulsar-assistant-tool-body",
      "pulsar-assistant-tool-body--collapsed",
    );
    block.appendChild(body);

    const toolView: ToolView = {
      element: block,
      heading,
      title,
      status,
      body,
      summary,
      toggle,
      expanded: false,
      collapsible: false,
      diff: false,
      location: null,
      locationTooltip: null,
    };
    this.toolViews.set(toolCall.toolCallId, toolView);

    toggle.addEventListener("click", () => {
      setCollapsed(toolView, toolView.expanded);
      this.host.scrollToBottom();
    });

    this.updateToolView(toolCall.toolCallId, {
      toolCallId: toolCall.toolCallId,
      status: toolCall.status,
      title: toolCall.title,
      kind: toolCall.kind,
      rawInput: toolCall.rawInput,
      rawOutput: toolCall.rawOutput,
      content: toolCall.content,
      locations: toolCall.locations,
    });

    container.appendChild(block);
    this.host.scrollToBottom();
    return block;
  }

  updateToolView(id: string, update: ToolUpdate): void {
    const view = this.toolViews.get(id);
    if (!view) return;

    if (update.title) {
      view.title.textContent = update.title;
    }

    if (update.kind) {
      view.element.dataset.kind = update.kind;
    }

    if (update.status) {
      view.status.textContent = update.status;
      view.element.dataset.status = update.status;
    }

    if (update.locations && update.locations.length > 0) {
      const loc = update.locations[0];
      view.location = loc;
      if (!view.heading.querySelector(".pulsar-assistant-location")) {
        const link = document.createElement("button");
        link.classList.add("btn-link", "pulsar-assistant-location");
        const lineSuffix = loc.line != null ? `:${loc.line}` : "";
        link.textContent = `${loc.path}${lineSuffix}`;
        link.addEventListener("click", (e) => {
          e.stopPropagation();
          this.host.openLocation(loc.path, loc.line ?? undefined);
        });
        view.heading.insertBefore(link, view.status);
      }
    }

    const hasContent = update.content && update.content.length > 0;
    const hasRaw = update.rawInput != null || update.rawOutput != null;
    if (!hasContent && !hasRaw) return;

    view.body.replaceChildren();
    if (hasContent) {
      for (const item of update.content!) {
        view.body.appendChild(
          this.host.renderToolContent
            ? this.host.renderToolContent(item)
            : this.renderToolContent(item),
        );
      }
      view.diff = update.content![0].type === "diff";
    } else if (update.rawInput != null || update.rawOutput != null) {
      if (update.rawInput != null) {
        const pre = document.createElement("pre");
        pre.classList.add("pulsar-assistant-code-block");
        pre.textContent =
          typeof update.rawInput === "string"
            ? update.rawInput
            : JSON.stringify(update.rawInput, null, 2);
        view.body.appendChild(pre);
      }
      if (update.rawOutput != null) {
        const pre = document.createElement("pre");
        pre.classList.add("pulsar-assistant-code-block");
        pre.textContent =
          typeof update.rawOutput === "string"
            ? update.rawOutput
            : JSON.stringify(update.rawOutput, null, 2);
        view.body.appendChild(pre);
      }
    }

    const summaryText = summarizeToolUpdate(update);
    view.summary.textContent = summaryText;
    view.summary.style.display = summaryText ? "" : "none";

    const wasCollapsible = view.collapsible;
    view.collapsible = true;
    view.toggle.style.display = "";
    if (!wasCollapsible) {
      setCollapsed(view, true);
    }
  }
}
