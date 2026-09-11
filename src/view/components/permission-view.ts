import type * as acp from "@agentclientprotocol/sdk";
import type { Disposable } from "atom";

export interface PermissionHost {
  openLocation: (path: string, line?: number) => Promise<void>;
  renderToolContent: (item: acp.ToolCallContent) => HTMLElement;
  makeButton: (label: string, onClick: () => void) => HTMLButtonElement;
  addTooltipDisposable: (d: Disposable) => void;
  scrollToBottom: () => void;
  onPermissionAwaiting?: () => void;
  onPermissionResolved?: (optionId: string) => void;
}

export class PermissionManager {
  private host: PermissionHost;
  private sessionApprovedKinds = new Set<string>();
  private autoApprove = false;
  private awaitingAuth = false;
  private currentAuthCard: HTMLElement | null = null;
  private authTooltips = new Set<Disposable>();

  constructor(host: PermissionHost) {
    this.host = host;
  }

  isAutoApprove(): boolean {
    return this.autoApprove;
  }

  setAutoApprove(value: boolean): void {
    this.autoApprove = value;
  }

  isAwaitingAuth(): boolean {
    return this.awaitingAuth;
  }

  setAwaitingAuth(value: boolean): void {
    this.awaitingAuth = value;
  }

  resetSessionApprovals(): void {
    this.sessionApprovedKinds.clear();
  }

  clearSessionApprovedKinds(): void {
    this.resetSessionApprovals();
  }

  markPendingPermissionsCancelled(container: HTMLElement): void {
    const blocks = container.querySelectorAll<HTMLElement>(
      ".pulsar-assistant-permission",
    );
    for (const block of blocks) {
      const buttons = block.querySelector(
        ".pulsar-assistant-permission-buttons",
      );
      if (buttons && buttons.childElementCount > 0) {
        buttons.replaceChildren();
        const note = document.createElement("span");
        note.classList.add("pulsar-assistant-permission-settled");
        note.textContent = "Cancelled";
        block.appendChild(note);
      }
    }
  }

  renderPermission(
    container: HTMLElement,
    params: acp.RequestPermissionRequest,
    respond: (outcome: acp.RequestPermissionResponse) => void,
  ): void {
    const toolCall = params.toolCall;
    const toolTitle = toolCall?.title || "an action";
    const kind = toolCall?.kind;

    if (kind && this.sessionApprovedKinds.has(kind)) {
      const option = params.options?.find(
        (o: acp.PermissionOption) => o.kind === "allow_once",
      );
      if (option) {
        respond({ outcome: { outcome: "selected", optionId: option.optionId } });
        this.host.onPermissionResolved?.(option.optionId);
        return;
      }
    }

    if (this.autoApprove) {
      const option = params.options?.find(
        (o: acp.PermissionOption) => o.kind === "allow_once",
      );
      if (option) {
        respond({ outcome: { outcome: "selected", optionId: option.optionId } });
        this.host.onPermissionResolved?.(option.optionId);
        return;
      }
    }

    this.host.onPermissionAwaiting?.();

    const block = document.createElement("div");
    block.classList.add("pulsar-assistant-permission");
    block.dataset.toolTitle = toolTitle;
    if (kind) block.dataset.kind = kind;

    const kindIcons: Record<string, string> = {
      read: "file-text",
      edit: "pencil",
      delete: "trashcan",
      move: "arrow-right",
      search: "search",
      execute: "terminal",
      terminal: "terminal",
      browser: "globe",
      fetch: "cloud-download",
      auth: "key",
    };

    const header = document.createElement("div");
    header.classList.add("pulsar-assistant-permission-header");

    const icon = document.createElement("span");
    icon.classList.add(
      "icon",
      `icon-${(kind && kindIcons[kind]) || "question"}`,
    );
    header.appendChild(icon);

    const titleEl = document.createElement("span");
    titleEl.classList.add("pulsar-assistant-permission-title");
    titleEl.textContent = `Permission required for ${toolTitle}`;
    header.appendChild(titleEl);

    if (kind) {
      const tag = document.createElement("span");
      tag.classList.add("pulsar-assistant-tag");
      tag.textContent = kind;
      header.appendChild(tag);
    }
    block.appendChild(header);

    if (toolCall?.locations && toolCall.locations.length > 0) {
      const locList = document.createElement("div");
      locList.classList.add("pulsar-assistant-permission-locations");
      for (const loc of toolCall.locations) {
        const link = document.createElement("button");
        link.classList.add("btn-link", "pulsar-assistant-location");
        const lineSuffix = loc.line != null ? `:${loc.line}` : "";
        link.textContent = `${loc.path}${lineSuffix}`;
        link.addEventListener("click", () =>
          this.host.openLocation(loc.path, loc.line ?? undefined),
        );
        locList.appendChild(link);
      }
      block.appendChild(locList);
    }

    if (toolCall?.content && toolCall.content.length > 0) {
      const details = document.createElement("details");
      details.classList.add("pulsar-assistant-permission-details");
      const summary = document.createElement("summary");
      summary.textContent = "Details";
      details.appendChild(summary);
      const inner = document.createElement("div");
      inner.classList.add("pulsar-assistant-permission-content");
      for (const item of toolCall.content) {
        inner.appendChild(this.host.renderToolContent(item));
      }
      details.appendChild(inner);
      block.appendChild(details);
    }

    if (toolCall?.rawInput) {
      const details = document.createElement("details");
      details.classList.add("pulsar-assistant-permission-details");
      const summary = document.createElement("summary");
      summary.textContent = "Raw Arguments";
      details.appendChild(summary);
      const pre = document.createElement("pre");
      pre.classList.add("pulsar-assistant-code-block");
      pre.textContent = JSON.stringify(toolCall.rawInput, null, 2);
      details.appendChild(pre);
      block.appendChild(details);
    }

    const buttons = document.createElement("div");
    buttons.classList.add("pulsar-assistant-permission-buttons");

    let settled = false;
    const settle = (optionId: string, chosenLabel: string) => {
      if (settled) return;
      settled = true;
      buttons.replaceChildren();
      const note = document.createElement("span");
      note.classList.add("pulsar-assistant-permission-settled");
      note.textContent = `Decision: ${chosenLabel}`;
      block.appendChild(note);
      respond({ outcome: { outcome: "selected", optionId } });
      this.host.onPermissionResolved?.(optionId);
    };

    for (const option of params.options || []) {
      const button = this.host.makeButton(option.name, () => {
        if (option.kind === "allow_always" && kind) {
          this.sessionApprovedKinds.add(kind);
        }
        settle(option.optionId, option.name);
      });
      button.dataset.optionKind = option.kind;
      if (option.kind === "allow_once" || option.kind === "allow_always") {
        button.classList.add("btn-primary", "pulsar-assistant-confirm");
      }
      if (option.kind === "reject_once" || option.kind === "reject_always") {
        button.classList.add("pulsar-assistant-reject");
      }
      if (option.kind === "allow_always") {
        button.classList.add("pulsar-assistant-allow-always");
      }
      buttons.appendChild(button);
    }

    const allowOnce = params.options?.find(
      (o: acp.PermissionOption) => o.kind === "allow_once",
    );
    if (allowOnce && kind) {
      const sessionAllow = this.host.makeButton("Allow for this session", () => {
        this.sessionApprovedKinds.add(kind);
        settle(allowOnce.optionId, "Allow for this session");
      });
      sessionAllow.dataset.optionKind = "allow_once";
      buttons.appendChild(sessionAllow);
    }

    block.appendChild(buttons);
    container.appendChild(block);
    this.host.scrollToBottom();
  }

  renderAuthPicker(
    container: HTMLElement,
    methods: acp.AuthMethodAgent[],
    respond: (methodId: acp.AuthMethodId | null) => void,
  ): void {
    this.removeAuthCard();
    this.awaitingAuth = true;

    const card = document.createElement("div");
    card.classList.add("pulsar-assistant-auth-card");
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", "Authentication required");

    const header = document.createElement("div");
    header.classList.add("pulsar-assistant-auth-header");

    const icon = document.createElement("span");
    icon.classList.add("icon", "icon-key");
    header.appendChild(icon);

    const titleEl = document.createElement("span");
    titleEl.classList.add("pulsar-assistant-auth-title");
    titleEl.textContent = "Agent requires authentication";
    header.appendChild(titleEl);
    card.appendChild(header);

    const desc = document.createElement("div");
    desc.classList.add("pulsar-assistant-auth-desc");
    desc.textContent =
      "Select an authentication method to allow the agent to start:";
    card.appendChild(desc);

    const list = document.createElement("div");
    list.classList.add("pulsar-assistant-auth-methods");

    let settled = false;
    const settle = (
      methodId: acp.AuthMethodId | null,
      chosenLabel?: string,
    ) => {
      if (settled) return;
      settled = true;
      this.awaitingAuth = false;
      list.replaceChildren();
      if (chosenLabel) {
        const note = document.createElement("span");
        note.classList.add("pulsar-assistant-auth-settled");
        note.textContent = `Authenticating: ${chosenLabel}\u2026`;
        card.appendChild(note);
      }
      respond(methodId);
    };

    for (const method of methods) {
      const btn = this.host.makeButton(method.name, () => {
        settle(method.id, method.name);
      });
      btn.classList.add("btn-primary", "pulsar-assistant-auth-btn");
      if (method.description) {
        this.authTooltips.add(
          atom.tooltips.add(btn, {
            title: method.description,
            html: false,
            placement: "top",
            class: "pulsar-assistant-tooltip",
          }),
        );
      }
      list.appendChild(btn);
    }

    const cancelBtn = this.host.makeButton("Cancel", () => settle(null));
    cancelBtn.classList.add("pulsar-assistant-auth-cancel");
    list.appendChild(cancelBtn);

    card.appendChild(list);
    container.appendChild(card);
    this.currentAuthCard = card;
    this.host.scrollToBottom();
  }

  removeAuthCard(): void {
    if (this.currentAuthCard) {
      this.currentAuthCard.remove();
      this.currentAuthCard = null;
    }
    for (const d of this.authTooltips) d.dispose();
    this.authTooltips.clear();
  }
}
