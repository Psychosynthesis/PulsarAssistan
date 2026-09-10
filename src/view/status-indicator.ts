import { CompositeDisposable, Disposable } from "atom";
import type { StatusBar, Tile } from "atom/status-bar";
import type { AgentStatus } from "./agent-view";
import { resolveCurrentProjectRoot, sameProjectRoot } from "../workspace";

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "Idle",
  connecting: "Connecting\u2026",
  ready: "Ready",
  working: "Working\u2026",
  awaiting: "Awaiting confirmation\u2026",
  error: "Error",
};

export interface AgentStatusReporter {
  report(
    view: { projectRoot: string },
    status: AgentStatus,
    name: string | null,
  ): void;
  clear(view: { projectRoot: string }): void;
}

export class StatusIndicator implements AgentStatusReporter {
  private element: HTMLElement;
  private nameEl: HTMLElement;
  private dotEl: HTMLElement;
  private tile: Tile | null = null;
  private tooltip: Disposable;
  private subscriptions = new CompositeDisposable();
  private byRoot = new Map<
    string,
    { view: { projectRoot: string }; status: AgentStatus; name: string | null }
  >();
  private onClick: () => void;

  constructor(onClick: () => void) {
    this.onClick = onClick;
    this.element = document.createElement("a");
    this.element.classList.add("pulsar-assistant-status-tile", "inline-block");
    this.element.addEventListener("click", () => this.onClick());

    const icon = document.createElement("span");
    icon.classList.add("icon", "icon-hubot");

    this.nameEl = document.createElement("span");
    this.nameEl.classList.add("pulsar-assistant-status-tile-name");

    this.dotEl = document.createElement("span");
    this.dotEl.classList.add("pulsar-assistant-status-tile-dot");

    this.element.appendChild(icon);
    this.element.appendChild(this.nameEl);
    this.element.appendChild(this.dotEl);
    this.tooltip = atom.tooltips.add(this.element, {
      title: () => this.title(),
      html: false,
    });
    this.subscriptions.add(
      atom.workspace.onDidChangeActivePaneItem(() => this.render()),
      atom.workspace.onDidChangeActiveTextEditor(() => this.render()),
    );
    this.render();
  }

  setStatusBar(statusBar: StatusBar): void {
    this.tile?.destroy();
    this.tile = statusBar.addRightTile({ item: this.element, priority: 100 });
  }

  report(
    view: { projectRoot: string },
    status: AgentStatus,
    name: string | null,
  ): void {
    this.byRoot.set(view.projectRoot, { view, status, name });
    this.render();
  }

  clear(view: { projectRoot: string }): void {
    const current = this.byRoot.get(view.projectRoot);
    if (current?.view !== view) return;
    this.byRoot.delete(view.projectRoot);
    this.render();
  }

  destroy(): void {
    this.tooltip.dispose();
    this.subscriptions.dispose();
    this.tile?.destroy();
    this.tile = null;
    this.byRoot.clear();
  }

  private currentEntry(): {
    view: { projectRoot: string };
    status: AgentStatus;
    name: string | null;
  } | null {
    const filePath = atom.workspace.getCenter().getActiveTextEditor()?.getPath();
    const root = resolveCurrentProjectRoot(filePath);
    if (!root) return null;
    for (const [stored, entry] of this.byRoot) {
      if (sameProjectRoot(stored, root)) return entry;
    }
    return null;
  }

  private render(): void {
    const entry = this.currentEntry();
    this.nameEl.textContent = entry?.name || "Agent";
    this.dotEl.dataset.status = entry?.status ?? "idle";
  }

  private title(): string {
    const entry = this.currentEntry();
    if (!entry) return "Pulsar Assistant \u00b7 Off for this project";
    const label = STATUS_LABELS[entry.status];
    return entry.name
      ? `${entry.name} \u00b7 ${label}`
      : `Pulsar Assistant \u00b7 ${label}`;
  }
}
