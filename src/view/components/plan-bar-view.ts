import type * as acp from "@agentclientprotocol/sdk";
import {
  completedPlanEntries,
  nextTurnActivePlanEntries,
} from "../../util";

export interface PlanBarHost {
  onPlanChanged?: () => void;
  appendSnapshotToConversation: (card: HTMLElement) => void;
  scrollToBottom: () => void;
}

export class PlanBarView {
  private element: HTMLElement;
  private planExpanded = true;
  private activePlanEntries: acp.PlanEntry[] = [];
  private activePlanSessionId: string | null = null;
  private sessionPlanState = new Map<string, acp.PlanEntry[]>();
  private host: PlanBarHost;

  constructor(host: PlanBarHost) {
    this.host = host;
    this.element = document.createElement("div");
    this.element.classList.add("pulsar-assistant-plan-bar");
    this.element.style.display = "none";
  }

  getElement(): HTMLElement {
    return this.element;
  }

  get hasActivePlan(): boolean {
    return this.activePlanEntries.length > 0;
  }

  get entries(): acp.PlanEntry[] {
    return this.activePlanEntries;
  }

  clear(): void {
    this.activePlanEntries = [];
    this.activePlanSessionId = null;
    this.element.style.display = "none";
    this.element.replaceChildren();
    this.host.onPlanChanged?.();
  }

  clearActivePlan(): void {
    this.clear();
  }

  setActivePlan(
    entries: acp.PlanEntry[],
    sessionId: string | null = null,
  ): void {
    if (sessionId) {
      this.sessionPlanState.set(sessionId, entries);
    }
    this.activePlanSessionId = sessionId;
    this.activePlanEntries = entries;
    this.render();
    this.host.onPlanChanged?.();
  }

  syncSession(sessionId: string | null): void {
    this.activePlanSessionId = sessionId;
    if (sessionId && this.sessionPlanState.has(sessionId)) {
      this.activePlanEntries = this.sessionPlanState.get(sessionId)!;
      this.render();
    } else {
      this.activePlanEntries = [];
      this.element.style.display = "none";
      this.element.replaceChildren();
    }
    this.host.onPlanChanged?.();
  }

  removeSession(sessionId: string): void {
    this.sessionPlanState.delete(sessionId);
    if (this.activePlanSessionId === sessionId) {
      this.clear();
    }
  }

  snapshotCompletedPlan(): void {
    if (this.activePlanEntries.length === 0) return;

    const completed = completedPlanEntries(this.activePlanEntries);
    if (completed.length > 0) {
      const card = document.createElement("div");
      card.classList.add("pulsar-assistant-plan-card");
      card.dataset.completedCount = String(completed.length);

      const header = document.createElement("div");
      header.classList.add("pulsar-assistant-plan-card-header");

      const icon = document.createElement("span");
      icon.classList.add("icon", "icon-tasklist");
      header.appendChild(icon);

      const title = document.createElement("span");
      title.classList.add("pulsar-assistant-plan-card-title");
      title.textContent = `Completed steps (${completed.length})`;
      header.appendChild(title);
      card.appendChild(header);

      const list = document.createElement("ul");
      list.classList.add("pulsar-assistant-plan-card-list");
      for (const entry of completed) {
        const item = document.createElement("li");
        item.classList.add(
          "pulsar-assistant-plan-card-item",
          "is-completed",
        );
        const checkIcon = document.createElement("span");
        checkIcon.classList.add("icon", "icon-check");
        item.appendChild(checkIcon);
        const text = document.createElement("span");
        text.classList.add("pulsar-assistant-plan-card-text");
        text.textContent = entry.content;
        item.appendChild(text);
        list.appendChild(item);
      }
      card.appendChild(list);

      this.host.appendSnapshotToConversation(card);
      this.host.scrollToBottom();
    }
  }

  clearCompletedActivePlanEntries(): void {
    this.activePlanEntries = nextTurnActivePlanEntries(this.activePlanEntries);
    if (this.activePlanSessionId) {
      this.sessionPlanState.set(
        this.activePlanSessionId,
        this.activePlanEntries,
      );
    }
    this.render();
    this.host.onPlanChanged?.();
  }

  onTurnCompleted(): void {
    this.snapshotCompletedPlan();
    this.clearCompletedActivePlanEntries();
  }

  private render(): void {
    if (this.activePlanEntries.length === 0) {
      this.element.style.display = "none";
      this.element.replaceChildren();
      return;
    }

    this.element.style.display = "";
    this.element.replaceChildren();

    const total = this.activePlanEntries.length;
    const completed = this.activePlanEntries.filter(
      (e) => e.status === "completed",
    ).length;
    const inProgress = this.activePlanEntries.filter(
      (e) => e.status === "in_progress",
    ).length;

    const summary = document.createElement("div");
    summary.classList.add("pulsar-assistant-plan-summary");
    summary.addEventListener("click", () => {
      this.planExpanded = !this.planExpanded;
      this.render();
    });

    const chevron = document.createElement("span");
    chevron.classList.add(
      "icon",
      this.planExpanded ? "icon-chevron-down" : "icon-chevron-right",
    );
    summary.appendChild(chevron);

    const title = document.createElement("span");
    title.classList.add("pulsar-assistant-plan-title");
    title.textContent = `Plan (${completed}/${total} completed${
      inProgress ? `, ${inProgress} in progress` : ""
    })`;
    summary.appendChild(title);
    this.element.appendChild(summary);

    if (this.planExpanded) {
      const list = document.createElement("ul");
      list.classList.add("pulsar-assistant-plan-list");
      for (const entry of this.activePlanEntries) {
        const item = document.createElement("li");
        item.classList.add(
          "pulsar-assistant-plan-entry",
          `status-${entry.status}`,
        );

        const statusIcon = document.createElement("span");
        statusIcon.classList.add("icon");
        if (entry.status === "completed") {
          statusIcon.classList.add("icon-check");
        } else if (entry.status === "in_progress") {
          statusIcon.classList.add("icon-sync", "pulsar-assistant-spin");
        } else {
          statusIcon.classList.add("icon-primitive-dot");
        }
        item.appendChild(statusIcon);

        const text = document.createElement("span");
        text.classList.add("pulsar-assistant-plan-entry-text");
        text.textContent = entry.content;
        item.appendChild(text);

        list.appendChild(item);
      }
      this.element.appendChild(list);
    }
  }
}
