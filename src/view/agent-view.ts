import * as path from "path";
import { CompositeDisposable, Disposable, TextEditor } from "atom";
import type * as acp from "@agentclientprotocol/sdk";
import {
  AgentSession,
  AgentEvent,
  isStartupCancellation,
} from "../session/agent-session";
import {
  AgentsConfig,
  LaunchTarget,
  OpenaiLaunchTarget,
  groupAgents,
  isLaunchedAgentStale,
  launchTargetsEqual,
  resolveAgent,
  toLaunchTarget,
} from "../agent-config";
import {
  OpenAiModelInfo,
  fetchOpenAiModels,
} from "../openai-client";
import {
  readAgentsConfig,
  readProjectPolicy,
  setActiveAgentId,
  setProjectMaxTurnRequests,
  setProjectTestCommand,
  setProjectToolCallDelay,
} from "./config-store";
import {
  ConfigSelector,
  SelectConfigOption,
  configLockKey,
} from "./config-selector";
import { ModelSelector } from "./model-selector";
import { ContextProgressBar } from "./context-progress-bar";
import { renderMarkdownHtml } from "./markdown";
import { ComposerStatusBar } from "./components/composer-status-bar";
import { PlanBarView } from "./components/plan-bar-view";
import { ToolCallManager, ToolUpdate } from "./components/tool-call-view";
import { PermissionManager } from "./components/permission-view";
import { TestCommandModal } from "./components/test-command-modal";
import type { AgentStatusReporter } from "./status-indicator";
import { estimateSessionTokens, resolveContextWindow } from "../token-estimate";
import { fileUri } from "../util";

/**
 * Architecture note - View Refactoring:
 * Extracted modules in src/view/components/:
 * - ComposerStatusBar: real-time thoughts, tool status, compaction notifications
 * - PlanBarView: agent task plan checklist, progress and completed snapshots
 * - ToolCallManager: collapsible tool executions, diffs, line counts
 * - PermissionManager: permission dialogs, allow/reject, auth picker
 *
 * TODO (Future Phase 2):
 * - Extract SessionListView into src/view/components/session-list-view.ts
 * - Extract PromptAttachmentsView into src/view/components/prompt-attachments-view.ts
 * - Extract InfoPanel / Details into src/view/components/info-panel-view.ts
 */

export type AgentStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "working"
  | "awaiting"
  | "warning"
  | "error";

type PendingContext =
  | { kind: "file"; path: string }
  | { kind: "selection"; path: string; rangeText: string };

type MaterializedContext = {
  kind: "file" | "selection";
  label: string;
  uri: string;
  text: string;
};

function flattenInfoRows(
  value: unknown,
  prefix = "",
): Array<{ key: string; value: string }> {
  if (value == null) return [];
  if (typeof value !== "object") {
    return [{ key: prefix, value: String(value) }];
  }
  const rows: Array<{ key: string; value: string }> = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const nextKey = prefix ? `${prefix}.${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      rows.push(...flattenInfoRows(v, nextKey));
    } else {
      rows.push({
        key: nextKey,
        value: typeof v === "string" ? v : JSON.stringify(v),
      });
    }
  }
  return rows;
}

export class PulsarAssistantView {
  element!: HTMLElement;
  private agentPicker!: HTMLButtonElement;
  private agentMenu!: HTMLElement;
  private agentMenuOpen = false;
  private readonly agentMenuId = `pulsar-assistant-agent-menu-${Math.random().toString(36).slice(2, 9)}`;
  private readonly slashMenuId = `pulsar-assistant-slash-menu-${Math.random().toString(36).slice(2, 9)}`;
  private slashMenu!: HTMLElement;
  private slashHint!: HTMLElement;
  private slashHintCommand: string | null = null;
  private slashMatches: acp.AvailableCommand[] = [];
  private slashActiveIndex = 0;
  private slashMenuOpen = false;
  private liveStatusEl!: HTMLElement;
  private restartButton!: HTMLButtonElement;
  private infoButton!: HTMLButtonElement;
  private runtimeStatusEl!: HTMLElement;
  private infoPanel!: HTMLElement;
  private infoPanelOpen = false;
  private modelSelectorWrap!: HTMLElement;
  private modelSelector!: ModelSelector;
  private contextProgressBar!: ContextProgressBar;
  private sessionsToggle!: HTMLButtonElement;
  private compactButton!: HTMLButtonElement;
  private newSessionButton!: HTMLButtonElement;
  private settingsButton!: HTMLButtonElement;
  private settingsMenu!: HTMLElement;
  private settingsMenuOpen = false;
  private sessionsList!: HTMLElement;
  private sessionsListVisible = false;
  private knownSessions: acp.SessionInfo[] = [];
  private sessionConversationCache = new Map<string, HTMLElement>();
  private sessionLiveState = new Map<string, string | null>();
  private conversationWrapper!: HTMLElement;
  private conversation!: HTMLElement;
  private loadingOverlay!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private autoApproveButton!: HTMLButtonElement;
  private autoApprovePermissions = false;
  private maxTurnRequestsInput!: HTMLInputElement;
  private toolCallDelayInput!: HTMLInputElement;
  private followButton!: HTMLButtonElement;
  private followAgent = false;
  private followTargetPath: string | null = null;
  private followTargetLine: number | null = null;
  private followFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private followMarker: any = null;
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  private followPending: { path: string; line?: number | null } | null = null;
  private followGeneration = 0;
  private contextControl!: HTMLElement;
  private contextTrigger!: HTMLButtonElement;
  private contextMenu!: HTMLElement;
  private contextMenuVisible = false;
  private addSelectionItem!: HTMLButtonElement;
  private addFileItem!: HTMLButtonElement;
  private contextStrip!: HTMLElement;
  private pendingContext: PendingContext[] = [];
  private configSelectorsContainer!: HTMLElement;
  private configSelectors: ConfigSelector[] = [];
  private settingConfig = new Set<string>();
  private scrollToBottomButton!: HTMLButtonElement;
  private stickToBottom = true;
  private userEchoSkipCount = 0;

  // Extracted component managers
  private statusBar!: ComposerStatusBar;
  private planBarView!: PlanBarView;
  private toolCallManager!: ToolCallManager;
  private permissionManager!: PermissionManager;

  private streamRole: string | null = null;
  private streamMessageId: acp.MessageId | null = null;
  private streamBody: HTMLElement | null = null;
  private streamRawText = "";
  private streamRenderHandle: number | null = null;

  private subscriptions = new CompositeDisposable();
  private eventSubscription!: Disposable;
  private conversationTooltips = new CompositeDisposable();
  private sessionTooltips = new CompositeDisposable();

  private agentsConfig: AgentsConfig;
  private selectedAgentId: string | null = null;
  private selectedModelId: string | null = null;
  private modelList: OpenAiModelInfo[] | null = null;
  private modelsLoading = false;
  private modelWarning = false;
  private modelFetchController: AbortController | null = null;
  private modelFetchGeneration = 0;
  private activeTarget: LaunchTarget | null = null;
  private generatingIndicator: HTMLElement | null = null;
  private lifecycleStatus = "";
  private storedAgentInfo: acp.Implementation | null = null;
  private storedCapabilities: acp.AgentCapabilities | null = null;
  private currentTokens: string | null = null;
  private preparingPrompt = false;
  private agentExited = false;
  private isShown = false;

  constructor(
    readonly projectRoot: string,
    private readonly statusReporter?: AgentStatusReporter,
    initial?: { selectedAgentId?: string; selectedModelId?: string },
    public session: AgentSession = new AgentSession(projectRoot),
  ) {
    this.agentsConfig = readAgentsConfig();
    this.selectedAgentId =
      initial?.selectedAgentId ?? this.agentsConfig.activeAgentId ?? null;
    this.selectedModelId = initial?.selectedModelId ?? null;

    this.statusBar = new ComposerStatusBar();

    this.planBarView = new PlanBarView({
      appendSnapshotToConversation: (card) => this.conversation.appendChild(card),
      scrollToBottom: () => this.scrollToBottom(),
    });

    const self = this;
    this.toolCallManager = new ToolCallManager({
      openLocation: (p, l) => self.openLocation(p, l),
      scheduleFollow: (p, l) => self.scheduleFollow(p, l),
      get followAgent() {
        return self.followAgent;
      },
      addTooltipDisposable: (d) => self.conversationTooltips.add(d),
      onBeforeNewToolCall: () => self.endStreamingBlocks(),
      scrollToBottom: () => self.scrollToBottom(),
    });

    this.permissionManager = new PermissionManager({
      openLocation: (p, l) => self.openLocation(p, l),
      renderToolContent: (item) => self.toolCallManager.renderToolContent(item),
      makeButton: (label, onClick) => self.makeButton(label, onClick),
      addTooltipDisposable: (d) => self.conversationTooltips.add(d),
      scrollToBottom: () => self.scrollToBottom(),
      onPermissionAwaiting: () => {
        self.setGeneratingState("awaiting");
        self.setAgentStatus("awaiting");
      },
      onPermissionResolved: () => {
        if (self.session.running) {
          self.setGeneratingState("working");
          self.setAgentStatus("working");
        }
      },
    });

    this.buildUI();
    this.eventSubscription = this.session.onEvent((event) =>
      this.handleEvent(event),
    );
    this.subscriptions.add(this.eventSubscription);

    this.subscriptions.add(
      atom.workspace.onDidStopChangingActivePaneItem(() => {
        this.refreshContextMenuItems();
      }),
    );

    this.subscriptions.add(
      atom.config.onDidChange("pulsar-assistant.agents", () =>
        this.handleAgentsConfigChange(),
      ),
      atom.config.onDidChange("pulsar-assistant.activeAgent", () =>
        this.handleAgentsConfigChange(),
      ),
      atom.config.onDidChange("pulsar-assistant.modelContextWindows", () => {
        this.updateContextProgress();
      }),
    );

    const onTraffic = (e: Event) => {
      const custom = e as CustomEvent<{
        projectRoot: string;
        sessionId?: string;
        requestBytes: number;
        responseBytes: number;
      }>;
      if (!custom.detail || custom.detail.projectRoot !== this.projectRoot) {
        return;
      }
      this.updateLiveStatusTraffic();
    };
    document.addEventListener("pulsar-assistant:api-traffic", onTraffic);
    this.subscriptions.add({
      dispose: () => {
        document.removeEventListener(
          "pulsar-assistant:api-traffic",
          onTraffic,
        );
      },
    });

    const onBuiltinSessionNew = (e: Event) => {
      const custom = e as CustomEvent<{
        projectRoot: string;
        sessionId: string;
      }>;
      if (!custom.detail || custom.detail.projectRoot !== this.projectRoot) {
        return;
      }
      this.updateContextProgress();
    };
    document.addEventListener(
      "pulsar-assistant:builtin-session-new",
      onBuiltinSessionNew,
    );
    this.subscriptions.add({
      dispose: () => {
        document.removeEventListener(
          "pulsar-assistant:builtin-session-new",
          onBuiltinSessionNew,
        );
      },
    });

    this.renderAgentPicker();
    this.renderModelSelector();
    this.renderConfigSelectors();
    this.renderLiveRow();
    this.refreshTurnLimitInput();
    this.refreshToolDelayInput();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  focusComposer(): void {
    this.input.focus();
  }

  refreshAfterMigration(): void {
    this.handleAgentsConfigChange();
  }

  getTitle(): string {
    const base = path.basename(this.projectRoot) || this.projectRoot;
    return `Assistant \u2014 ${base}`;
  }

  getURI(): string {
    return `pulsar-assistant://project/${encodeURIComponent(this.projectRoot)}`;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  getDefaultLocation(): "right" {
    return "right";
  }

  getAllowedLocations(): Array<"left" | "right" | "bottom"> {
    return ["left", "right", "bottom"];
  }

  getIconName(): string {
    return "comment-discussion";
  }

  private get activeAgentName(): string | null {
    return this.activeTarget?.name ?? null;
  }

  private handleAgentsConfigChange(): void {
    const previousTarget = this.activeTarget;
    this.agentsConfig = readAgentsConfig();
    this.selectedAgentId = this.agentsConfig.activeAgentId ?? null;
    this.renderAgentPicker();
    const liveTarget = this.session.launchedAgent;
    if (liveTarget) {
      if (!isLaunchedAgentStale(this.agentsConfig, liveTarget.id)) {
        const agent = this.agentsConfig.agents[liveTarget.id];
        if (agent) {
          try {
            this.activeTarget = toLaunchTarget(
              liveTarget.id,
              agent,
              process.env,
              liveTarget.kind === "openai" ? liveTarget.model : undefined,
            );
          } catch {
            this.activeTarget = liveTarget;
          }
        }
      }
    } else {
      const resolved = resolveAgent(
        this.agentsConfig,
        this.agentsConfig.activeAgentId,
      );
      this.activeTarget = resolved.agent
        ? toLaunchTarget(resolved.id!, resolved.agent)
        : null;
    }
    if (this.activeTarget?.kind === "openai") {
      this.selectedModelId = this.activeTarget.model;
      if (
        !previousTarget ||
        previousTarget.kind !== "openai" ||
        previousTarget.id !== this.activeTarget.id ||
        previousTarget.baseUrl !== this.activeTarget.baseUrl ||
        previousTarget.apiKey !== this.activeTarget.apiKey
      ) {
        void this.fetchModelsForTarget(this.activeTarget);
      }
    } else {
      this.selectedModelId = null;
      this.modelList = null;
      this.modelsLoading = false;
      this.modelWarning = false;
      this.modelFetchController?.abort();
      this.modelFetchController = null;
      this.modelFetchGeneration++;
    }
    this.renderModelSelector();
    this.updateContextProgress();
    if (this.infoPanelOpen) this.renderInfoPanel();
    this.renderLiveRow();
    if (this.isShown && !this.session.sessionId && !this.session.running) {
      this.ensureStarted();
    }
  }

  private updateContextProgress(): void {
    const messages = this.session.getSessionMessages();
    const pendingText = this.input ? this.input.value : "";
    const currentModel = this.currentModelId() || "gpt-4o";
    const used = estimateSessionTokens(messages, pendingText);
    const max = resolveContextWindow(currentModel);
    this.contextProgressBar.update(used, max);
  }

  private currentModelId(): string | null {
    if (this.selectedModelId) return this.selectedModelId;
    const target = this.activeTarget;
    if (target && target.kind === "openai") return target.model;
    return null;
  }

  private currentModelDescription(): string | null {
    const modelId = this.currentModelId();
    if (!modelId || !this.modelList) return null;
    const found = this.modelList.find((m) => m.id === modelId);
    return found?.description ?? null;
  }

  private modelSelectorDisabled(): boolean {
    return (
      !this.activeTarget ||
      this.activeTarget.kind !== "openai" ||
      this.modelsLoading ||
      this.session.switching ||
      this.session.running
    );
  }

  private renderModelSelector(): void {
    const target = this.activeTarget;
    if (!target || target.kind !== "openai") {
      this.modelSelectorWrap.style.display = "none";
      this.modelSelector.render(null, null, false);
      return;
    }
    this.modelSelectorWrap.style.display = "";
    this.modelSelector.render(
      this.selectedModelId || target.model,
      this.modelList,
      this.modelsLoading,
    );
  }

  private selectModel(id: string): void {
    if (this.modelSelectorDisabled()) return;
    const target = this.activeTarget;
    if (!target || target.kind !== "openai") return;
    if (target.model === id) return;
    const agent = this.agentsConfig.agents[target.id];
    if (!agent) return;
    let next: LaunchTarget;
    try {
      next = toLaunchTarget(target.id, agent, process.env, id);
    } catch (error) {
      this.appendError(error instanceof Error ? error.message : String(error));
      return;
    }
    this.selectedModelId = id;
    this.activeTarget = next;
    this.session.setModel(id);
    this.renderModelSelector();
    this.updateContextProgress();
    if (this.infoPanelOpen) this.renderInfoPanel();
    if (this.conversation.childElementCount > 0) {
      this.appendNote(`Model switched to ${id}`);
    }
  }

  private async fetchModelsForTarget(
    target: OpenaiLaunchTarget,
  ): Promise<void> {
    this.modelFetchController?.abort();
    const controller = new AbortController();
    this.modelFetchController = controller;
    const generation = ++this.modelFetchGeneration;
    this.modelList = null;
    this.modelsLoading = true;
    this.modelWarning = false;
    this.renderModelSelector();
    try {
      const models = await fetchOpenAiModels({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        modelsUrl: target.modelsUrl,
        signal: controller.signal,
      });
      if (generation !== this.modelFetchGeneration || controller.signal.aborted) {
        return;
      }
      this.modelList = models;
      this.modelsLoading = false;
      this.modelWarning = false;
      this.renderModelSelector();
      this.updateContextProgress();
      if (this.infoPanelOpen) this.renderInfoPanel();
    } catch {
      if (generation !== this.modelFetchGeneration || controller.signal.aborted) {
        return;
      }
      this.modelList = null;
      this.modelsLoading = false;
      this.modelWarning = true;
      this.renderModelSelector();
      this.setAgentStatus("warning");
    }
  }

  private renderNoAgentIdle(): void {
    const reason = resolveAgent(this.agentsConfig, this.selectedAgentId).reason;
    this.setLifecycleStatus(
      reason === "no-agents"
        ? "No agents configured \u2014 use the picker to add one."
        : "No agent selected \u2014 pick one from the menu.",
    );
    this.setAgentStatus("idle");
    this.renderAgentPicker();
    this.renderModelSelector();
    this.updateInputControls();
  }

  private handleStartupError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.hideLoadingOverlay();
    this.setGeneratingState(null);
    this.appendError(message);
    this.agentExited = true;
    this.currentTokens = null;
    this.renderLiveRow();
    this.finishAgentTeardown("Startup failed.");
  }

  private buildUI(): void {
    this.element = document.createElement("div");
    this.element.classList.add("pulsar-assistant");
    this.element.tabIndex = -1;

    const header = document.createElement("div");
    header.classList.add("pulsar-assistant-header");

    const row1 = document.createElement("div");
    row1.classList.add("pulsar-assistant-header-row1");

    const pickerWrap = document.createElement("div");
    pickerWrap.classList.add("pulsar-assistant-picker-wrap");
    this.agentPicker = document.createElement("button");
    this.agentPicker.classList.add("pulsar-assistant-picker");
    this.agentPicker.setAttribute("aria-haspopup", "menu");
    this.agentPicker.setAttribute("aria-controls", this.agentMenuId);
    this.agentPicker.setAttribute("aria-expanded", "false");
    this.agentPicker.addEventListener("click", () => this.toggleAgentMenu());
    this.subscriptions.add(
      atom.tooltips.add(this.agentPicker, {
        title: () =>
          isLaunchedAgentStale(this.agentsConfig, this.session.launchedAgent?.id)
            ? "This agent was removed from config; pick another to switch."
            : "Switch agent",
        placement: "right",
      }),
    );
    this.agentMenu = document.createElement("div");
    this.agentMenu.classList.add("pulsar-assistant-picker-menu");
    this.agentMenu.id = this.agentMenuId;
    this.agentMenu.setAttribute("role", "menu");
    this.agentMenu.setAttribute("aria-label", "Agents");
    this.agentMenu.style.display = "none";
    const onPickerKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.agentMenuOpen) {
        this.closeAgentMenu();
        this.agentPicker.focus();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!this.agentMenuOpen) this.openAgentMenu();
        this.focusAgentMenuItem("next");
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!this.agentMenuOpen) this.openAgentMenu();
        this.focusAgentMenuItem("previous");
        return;
      }
      if (event.key === "Home" && this.agentMenuOpen) {
        event.preventDefault();
        this.focusAgentMenuItem("first");
        return;
      }
      if (event.key === "End" && this.agentMenuOpen) {
        event.preventDefault();
        this.focusAgentMenuItem("last");
      }
    };
    this.agentPicker.addEventListener("keydown", onPickerKey);
    this.agentMenu.addEventListener("keydown", onPickerKey);
    pickerWrap.appendChild(this.agentPicker);
    pickerWrap.appendChild(this.agentMenu);

    const onDocMouseDown = (event: MouseEvent) => {
      if (this.agentMenuOpen && !pickerWrap.contains(event.target as Node)) {
        this.closeAgentMenu();
      }
    };
    document.addEventListener("mousedown", onDocMouseDown, true);
    this.subscriptions.add(
      new Disposable(() =>
        document.removeEventListener("mousedown", onDocMouseDown, true),
      ),
    );

    this.restartButton = this.makeButton("Restart", () => this.restart());
    this.restartButton.classList.add("pulsar-assistant-restart");
    this.subscriptions.add(
      atom.tooltips.add(this.restartButton, { title: "Restart agent" }),
    );
    row1.appendChild(pickerWrap);

    this.modelSelectorWrap = document.createElement("div");
    this.modelSelectorWrap.classList.add("pulsar-assistant-model-wrap");
    this.modelSelectorWrap.style.display = "none";
    this.modelSelector = new ModelSelector(
      (id) => this.selectModel(id),
      () => this.modelSelectorDisabled(),
      () => {
        this.closeAgentMenu();
        this.closeSettingsMenu();
        this.closeAllConfigMenus();
      },
    );
    this.modelSelectorWrap.appendChild(this.modelSelector.element);
    row1.appendChild(this.modelSelectorWrap);

    this.contextProgressBar = new ContextProgressBar();
    row1.appendChild(this.contextProgressBar.element);

    const onModelDocClick = (event: MouseEvent) => {
      if (
        this.modelSelector?.isOpen &&
        !this.modelSelector.contains(event.target as Node)
      ) {
        this.modelSelector.closeMenu();
      }
    };
    document.addEventListener("click", onModelDocClick);
    this.subscriptions.add(
      new Disposable(() =>
        document.removeEventListener("click", onModelDocClick),
      ),
    );
    const onModelKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.modelSelector?.isOpen) {
        this.modelSelector.closeMenu();
        this.modelSelector.focusButton();
      }
    };
    document.addEventListener("keydown", onModelKeyDown);
    this.subscriptions.add(
      new Disposable(() =>
        document.removeEventListener("keydown", onModelKeyDown),
      ),
    );

    this.compactButton = document.createElement("button");
    this.compactButton.classList.add(
      "pulsar-assistant-compact-context",
      "icon",
      "icon-fold",
    );
    this.compactButton.setAttribute("aria-label", "Compact context");
    this.compactButton.style.display = "none";
    this.subscriptions.add(
      atom.tooltips.add(this.compactButton, {
        title: "Compact conversation context",
      }),
    );
    this.compactButton.addEventListener("click", () => {
      void this.compactContext();
    });

    this.sessionsToggle = document.createElement("button");
    this.sessionsToggle.classList.add(
      "pulsar-assistant-sessions-toggle",
      "icon",
      "icon-history",
    );
    this.sessionsToggle.setAttribute("aria-label", "Sessions");
    this.sessionsToggle.setAttribute("aria-expanded", "false");
    this.sessionsToggle.style.display = "none";
    this.subscriptions.add(
      atom.tooltips.add(this.sessionsToggle, { title: "Sessions" }),
    );
    this.sessionsToggle.addEventListener("click", () => {
      this.setSessionsListVisible(!this.sessionsListVisible);
    });

    this.newSessionButton = document.createElement("button");
    this.newSessionButton.classList.add(
      "pulsar-assistant-new-session",
      "icon",
      "icon-plus",
    );
    this.newSessionButton.setAttribute("aria-label", "New session");
    this.newSessionButton.style.display = "none";
    this.subscriptions.add(
      atom.tooltips.add(this.newSessionButton, { title: "New session" }),
    );
    this.newSessionButton.addEventListener("click", () => this.startNewSession());

    const settingsWrap = document.createElement("div");
    settingsWrap.classList.add("pulsar-assistant-settings-wrap");
    settingsWrap.style.position = "relative";

    this.settingsButton = document.createElement("button");
    this.settingsButton.classList.add(
      "pulsar-assistant-settings-toggle",
      "pulsar-assistant-sessions-toggle",
      "icon",
      "icon-gear",
    );
    this.settingsButton.setAttribute("aria-label", "Project settings");
    this.settingsButton.setAttribute("aria-haspopup", "menu");
    this.settingsButton.setAttribute("aria-expanded", "false");
    this.settingsButton.addEventListener("click", () =>
      this.toggleSettingsMenu(),
    );
    this.subscriptions.add(
      atom.tooltips.add(this.settingsButton, {
        title: "Project settings",
        placement: "bottom",
      }),
    );

    this.settingsMenu = document.createElement("div");
    this.settingsMenu.classList.add(
      "pulsar-assistant-picker-menu",
      "pulsar-assistant-settings-menu",
    );
    this.settingsMenu.setAttribute("role", "menu");
    this.settingsMenu.setAttribute("aria-label", "Project settings");
    this.settingsMenu.style.display = "none";
    this.settingsMenu.style.left = "auto";
    this.settingsMenu.style.right = "0";

    const addSettingsItem = (label: string, onSelect: () => void): void => {
      const item = document.createElement("button");
      item.classList.add("pulsar-assistant-picker-item");
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.addEventListener("click", () => {
        this.closeSettingsMenu();
        onSelect();
      });
      this.settingsMenu.appendChild(item);
    };
    addSettingsItem("Set test command\u2026", () =>
      this.openTestCommandModal(),
    );
    addSettingsItem("Edit configuration\u2026", () =>
      atom.commands.dispatch(this.element, "pulsar-assistant:edit-agents"),
    );
    addSettingsItem("Manage projects & storage\u2026", () =>
      atom.commands.dispatch(this.element, "pulsar-assistant:manage-projects"),
    );

    settingsWrap.appendChild(this.settingsButton);
    settingsWrap.appendChild(this.settingsMenu);

    const onSettingsDocMouseDown = (event: MouseEvent) => {
      if (this.settingsMenuOpen && !settingsWrap.contains(event.target as Node)) {
        this.closeSettingsMenu();
      }
    };
    document.addEventListener("mousedown", onSettingsDocMouseDown, true);
    this.subscriptions.add(
      new Disposable(() =>
        document.removeEventListener("mousedown", onSettingsDocMouseDown, true),
      ),
    );

    const onSettingsKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.settingsMenuOpen) {
        this.closeSettingsMenu();
        this.settingsButton.focus();
      }
    };
    document.addEventListener("keydown", onSettingsKeyDown);
    this.subscriptions.add(
      new Disposable(() =>
        document.removeEventListener("keydown", onSettingsKeyDown),
      ),
    );

    this.sessionsList = document.createElement("div");
    this.sessionsList.classList.add("pulsar-assistant-sessions-list");
    this.sessionsList.style.display = "none";

    this.infoButton = document.createElement("button");
    this.infoButton.classList.add("pulsar-assistant-info-toggle");
    this.infoButton.textContent = "More\u2026";
    this.infoButton.setAttribute("aria-label", "Agent details");
    this.infoButton.setAttribute("aria-expanded", "false");
    this.infoButton.style.display = "none";
    this.infoButton.addEventListener("click", () =>
      this.setInfoPanelOpen(!this.infoPanelOpen),
    );
    this.subscriptions.add(
      atom.tooltips.add(this.infoButton, {
        title: "Show agent details and actions",
        placement: "bottom",
      }),
    );

    this.runtimeStatusEl = document.createElement("div");
    this.runtimeStatusEl.classList.add("pulsar-assistant-header-row2");
    this.liveStatusEl = document.createElement("span");
    this.liveStatusEl.classList.add("pulsar-assistant-token-usage");

    const rightGroup = document.createElement("div");
    rightGroup.classList.add("pulsar-assistant-header-right");
    rightGroup.appendChild(this.compactButton);
    rightGroup.appendChild(this.sessionsToggle);
    rightGroup.appendChild(this.newSessionButton);
    rightGroup.appendChild(settingsWrap);

    this.runtimeStatusEl.appendChild(this.infoButton);
    this.runtimeStatusEl.appendChild(this.liveStatusEl);

    row1.appendChild(rightGroup);
    header.appendChild(row1);
    header.appendChild(this.runtimeStatusEl);

    this.infoPanel = document.createElement("div");
    this.infoPanel.classList.add("pulsar-assistant-info-panel");
    this.infoPanel.style.display = "none";

    this.conversation = document.createElement("div");
    this.conversation.classList.add("pulsar-assistant-conversation");
    this.attachConversationScrollListener();

    this.conversationWrapper = document.createElement("div");
    this.conversationWrapper.classList.add("pulsar-assistant-conversation-wrapper");

    this.loadingOverlay = document.createElement("div");
    this.loadingOverlay.classList.add("pulsar-assistant-loading-overlay");
    this.loadingOverlay.style.display = "none";
    const loadingLabel = document.createElement("div");
    loadingLabel.classList.add("pulsar-assistant-loading-label");
    loadingLabel.textContent = "Loading session\u2026";
    this.loadingOverlay.appendChild(loadingLabel);

    const footer = document.createElement("div");
    footer.classList.add("pulsar-assistant-footer");

    this.contextStrip = document.createElement("div");
    this.contextStrip.classList.add("pulsar-assistant-context-strip");
    this.contextStrip.style.display = "none";

    this.input = document.createElement("textarea");
    this.input.classList.add("pulsar-assistant-input", "native-key-bindings");
    this.input.setAttribute("rows", "3");
    this.input.setAttribute(
      "placeholder",
      "Ask the agent\u2026  (Enter to send, Shift+Enter for newline)",
    );
    this.input.setAttribute("aria-controls", this.slashMenuId);
    this.input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (this.handleSlashKeydown(event)) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    this.input.addEventListener("input", () => {
      this.updateSlashMenu();
      this.updateContextProgress();
    });

    const actions = document.createElement("div");
    actions.classList.add("pulsar-assistant-actions");
    this.sendButton = this.makeButton("Send", () => this.send());
    this.sendButton.classList.add("pulsar-assistant-send");
    this.stopButton = this.makeButton("Stop", () => {
      this.setGeneratingState("stopping");
      this.cancelPendingFollow();
      this.session.cancel();
    });
    this.stopButton.classList.add("pulsar-assistant-stop");
    this.stopButton.disabled = true;

    this.autoApproveButton = document.createElement("button");
    this.autoApproveButton.classList.add(
      "btn",
      "pulsar-assistant-auto-approve",
    );
    this.autoApproveButton.textContent = "Permissions: Ask";
    this.autoApproveButton.setAttribute("aria-pressed", "false");
    this.autoApproveButton.addEventListener("click", () => {
      this.autoApprovePermissions = !this.autoApprovePermissions;
      this.permissionManager.setAutoApprove(this.autoApprovePermissions);
      this.updateAutoApproveButton();
    });
    this.subscriptions.add(
      atom.tooltips.add(this.autoApproveButton, {
        title:
          "Auto-approve permission prompts for this session using allow once.",
      }),
    );

    this.followButton = document.createElement("button");
    this.followButton.classList.add("btn", "pulsar-assistant-follow");
    this.followButton.textContent = "Follow: Off";
    this.followButton.setAttribute("aria-pressed", "false");
    this.followButton.addEventListener("click", () => {
      this.setFollowAgent(!this.followAgent);
    });
    this.subscriptions.add(
      atom.tooltips.add(this.followButton, {
        title:
          "Follow the agent: open and scroll to each file it works on for this session.",
      }),
      atom.workspace.onDidChangeActiveTextEditor((editor) => {
        if (!this.followAgent) return;
        const activePath = editor?.getPath();
        if (!activePath) return;
        if (this.followTargetPath && this.samePath(activePath, this.followTargetPath)) {
          return;
        }
        this.setFollowAgent(false);
      }),
    );

    actions.appendChild(this.buildContextControl());
    actions.appendChild(this.buildConfigSelectors());
    actions.appendChild(this.buildTurnLimitControl());
    actions.appendChild(this.buildToolDelayControl());
    actions.appendChild(this.autoApproveButton);

    const actionButtons = document.createElement("div");
    actionButtons.classList.add("pulsar-assistant-action-buttons");
    actionButtons.appendChild(this.followButton);
    actionButtons.appendChild(this.stopButton);
    actionButtons.appendChild(this.sendButton);

    footer.appendChild(this.contextStrip);
    footer.appendChild(this.statusBar.getElement());
    footer.appendChild(this.buildSlashComposer());
    footer.appendChild(actions);
    footer.appendChild(actionButtons);

    this.element.appendChild(header);
    this.element.appendChild(this.infoPanel);
    this.element.appendChild(this.sessionsList);
    this.conversationWrapper.appendChild(this.conversation);
    this.conversationWrapper.appendChild(this.loadingOverlay);

    this.scrollToBottomButton = document.createElement("button");
    this.scrollToBottomButton.classList.add(
      "pulsar-assistant-scroll-to-bottom",
      "icon",
      "icon-chevron-down",
    );
    this.scrollToBottomButton.textContent = "Scroll to bottom";
    this.scrollToBottomButton.setAttribute("aria-label", "Scroll to bottom");
    this.scrollToBottomButton.style.display = "none";
    this.scrollToBottomButton.addEventListener("click", () => {
      this.stickToBottom = true;
      this.updateScrollToBottomButton();
      this.scrollToBottom();
    });
    this.conversationWrapper.appendChild(this.scrollToBottomButton);

    this.element.appendChild(this.conversationWrapper);
    this.element.appendChild(this.planBarView.getElement());
    this.element.appendChild(footer);
  }

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.classList.add("btn");
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  private buildConfigSelectors(): HTMLElement {
    const container = document.createElement("div");
    container.classList.add("pulsar-assistant-config-selectors");
    container.style.display = "none";
    this.configSelectorsContainer = container;

    const onDocClick = (event: MouseEvent) => {
      for (const selector of this.configSelectors) {
        if (selector.isOpen && !selector.contains(event.target as Node)) {
          selector.closeMenu();
        }
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      for (const selector of this.configSelectors) {
        if (selector.isOpen) {
          selector.closeMenu();
          selector.focusButton();
        }
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    this.subscriptions.add({
      dispose: () => {
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKeyDown);
      },
    });

    return container;
  }

  private buildTurnLimitControl(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.classList.add("pulsar-assistant-turn-limit");

    const label = document.createElement("label");
    label.textContent = "Tool turns";
    label.htmlFor = "pulsar-assistant-turn-limit-input";

    this.maxTurnRequestsInput = document.createElement("input");
    this.maxTurnRequestsInput.id = "pulsar-assistant-turn-limit-input";
    this.maxTurnRequestsInput.type = "number";
    this.maxTurnRequestsInput.min = "1";
    this.maxTurnRequestsInput.max = "1000";
    this.maxTurnRequestsInput.step = "1";
    this.maxTurnRequestsInput.placeholder = "200";
    this.maxTurnRequestsInput.addEventListener("change", () => {
      this.saveTurnLimit();
    });

    this.subscriptions.add(
      atom.tooltips.add(wrap, {
        title:
          "Maximum tool calls in one turn for this project. Empty uses the default (200).",
        placement: "top",
        trigger: "hover",
      }),
    );

    wrap.appendChild(label);
    wrap.appendChild(this.maxTurnRequestsInput);
    return wrap;
  }

  private refreshTurnLimitInput(): void {
    if (!this.maxTurnRequestsInput) return;
    const policy = readProjectPolicy(this.projectRoot);
    this.maxTurnRequestsInput.value =
      policy.maxTurnRequests == null ? "" : String(policy.maxTurnRequests);
  }

  private saveTurnLimit(): void {
    const raw = this.maxTurnRequestsInput.value.trim();
    if (!raw) {
      setProjectMaxTurnRequests(this.projectRoot, null);
      this.refreshTurnLimitInput();
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      this.refreshTurnLimitInput();
      this.appendError("Tool turns must be a whole number from 1 to 1000.");
      return;
    }
    setProjectMaxTurnRequests(this.projectRoot, value);
    this.refreshTurnLimitInput();
  }

  private buildToolDelayControl(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.classList.add("pulsar-assistant-turn-limit");

    const label = document.createElement("label");
    label.textContent = "Delay (ms)";
    label.htmlFor = "pulsar-assistant-tool-delay-input";

    this.toolCallDelayInput = document.createElement("input");
    this.toolCallDelayInput.id = "pulsar-assistant-tool-delay-input";
    this.toolCallDelayInput.type = "number";
    this.toolCallDelayInput.min = "100";
    this.toolCallDelayInput.max = "60000";
    this.toolCallDelayInput.step = "50";
    this.toolCallDelayInput.placeholder = "500";
    this.toolCallDelayInput.addEventListener("change", () => {
      this.saveToolDelay();
    });

    this.subscriptions.add(
      atom.tooltips.add(wrap, {
        title:
          "Mandatory delay (in milliseconds) between tool calls for this project to prevent rate limit (TPM/429) errors. Minimum 100ms. Empty uses 500ms.",
        placement: "top",
        trigger: "hover",
      }),
    );

    wrap.appendChild(label);
    wrap.appendChild(this.toolCallDelayInput);
    return wrap;
  }

  private refreshToolDelayInput(): void {
    if (!this.toolCallDelayInput) return;
    const policy = readProjectPolicy(this.projectRoot);
    this.toolCallDelayInput.value =
      policy.toolCallDelayMs == null ? "" : String(policy.toolCallDelayMs);
  }

  private saveToolDelay(): void {
    const raw = this.toolCallDelayInput.value.trim();
    if (!raw) {
      setProjectToolCallDelay(this.projectRoot, null);
      this.refreshToolDelayInput();
      return;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 100) {
      this.refreshToolDelayInput();
      this.appendError("Tool call delay must be an integer >= 100 ms.");
      return;
    }
    setProjectToolCallDelay(this.projectRoot, value);
    this.refreshToolDelayInput();
  }

  private closeAllConfigMenus(): void {
    for (const selector of this.configSelectors) selector.closeMenu();
    this.modelSelector?.closeMenu();
    this.closeSettingsMenu();
  }

  private updateConfigSelectorsDisabled(): void {
    for (const selector of this.configSelectors) selector.updateDisabled();
  }

  private renderConfigSelectors(): void {
    const options = this.session.currentSessionConfigOptions();
    const selects = (options ?? []).filter(
      (o): o is SelectConfigOption => o.type === "select",
    );

    for (const selector of this.configSelectors) selector.dispose();
    this.configSelectors = [];
    this.configSelectorsContainer.replaceChildren();

    if (selects.length === 0) {
      this.configSelectorsContainer.style.display = "none";
      return;
    }
    this.configSelectorsContainer.style.display = "";

    for (const option of selects) {
      const configId = option.id;
      const selector = new ConfigSelector(
        (id, value) => this.selectConfigOption(id, value),
        () =>
          this.session.switching ||
          this.settingConfig.has(
            configLockKey(this.session.sessionId ?? "", configId),
          ),
        () => {
          this.closeAllConfigMenus();
          this.closeContextMenu();
        },
      );
      selector.render(option);
      this.configSelectors.push(selector);
      this.configSelectorsContainer.appendChild(selector.element);
    }
  }

  private selectConfigOption(configId: string, value: string): void {
    const options = this.session.currentSessionConfigOptions();
    const option = options?.find(
      (o): o is SelectConfigOption => o.id === configId && o.type === "select",
    );
    if (!option || option.currentValue === value) return;
    const sessionId = this.session.sessionId;
    const lockKey = configLockKey(sessionId ?? "", configId);
    if (this.session.switching || this.settingConfig.has(lockKey)) return;

    const previous = option.currentValue;
    option.currentValue = value;
    this.settingConfig.add(lockKey);
    this.renderConfigSelectors();
    this.session
      .setConfigOption(configId, value)
      .catch((error) => {
        if (option.currentValue === value) option.currentValue = previous;
        if (this.session.sessionId === sessionId) {
          this.appendError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        this.settingConfig.delete(lockKey);
        if (this.session.sessionId === sessionId) {
          this.renderConfigSelectors();
        } else {
          this.updateConfigSelectorsDisabled();
        }
      });
  }

  private setFollowAgent(on: boolean): void {
    this.followAgent = on;
    if (!on) this.clearFollowEffects();
    this.updateFollowButton();
  }

  private updateFollowButton(): void {
    this.followButton.setAttribute("aria-pressed", String(this.followAgent));
    this.followButton.textContent = this.followAgent
      ? "Follow: On"
      : "Follow: Off";
    this.followButton.classList.toggle(
      "pulsar-assistant-follow--on",
      this.followAgent,
    );
  }

  private clearFollowEffects(): void {
    this.cancelPendingFollow();
    if (this.followFlashTimer !== null) {
      clearTimeout(this.followFlashTimer);
      this.followFlashTimer = null;
    }
    this.followTargetPath = null;
    this.followTargetLine = null;
    this.followMarker?.destroy();
    this.followMarker = null;
  }

  private cancelPendingFollow(): void {
    this.followGeneration++;
    if (this.followTimer !== null) {
      clearTimeout(this.followTimer);
      this.followTimer = null;
    }
    this.followPending = null;
  }

  private scheduleFollow(filePath: string, line?: number | null): void {
    if (
      this.followTargetPath &&
      this.samePath(filePath, this.followTargetPath) &&
      (line ?? null) === this.followTargetLine
    ) {
      return;
    }
    this.followPending = { path: filePath, line };
    if (this.followTimer !== null) return;
    this.followTimer = setTimeout(() => {
      this.followTimer = null;
      const pending = this.followPending;
      this.followPending = null;
      if (pending) void this.followLocation(pending.path, pending.line);
    }, 150);
  }

  private async followLocation(
    filePath: string,
    line?: number | null,
  ): Promise<void> {
    const generation = ++this.followGeneration;
    const sessionId = this.session.sessionId;
    if (!(await this.isOpenableFile(filePath))) return;
    if (
      generation !== this.followGeneration ||
      !this.followAgent ||
      this.session.sessionId !== sessionId
    ) {
      return;
    }
    this.followTargetPath = filePath;
    this.followTargetLine = line ?? null;
    let editor: unknown;
    try {
      editor = await atom.workspace.open(filePath, {
        searchAllPanes: true,
        activatePane: false,
      });
    } catch {
      return;
    }
    if (
      generation !== this.followGeneration ||
      !this.followAgent ||
      this.session.sessionId !== sessionId ||
      !(editor instanceof TextEditor)
    ) {
      return;
    }
    const row = line ?? 0;
    editor.scrollToBufferPosition([row, 0], { center: true });
    this.flashFollowLine(editor, row);
  }

  private flashFollowLine(editor: TextEditor, row: number): void {
    this.followMarker?.destroy();
    if (this.followFlashTimer !== null) clearTimeout(this.followFlashTimer);
    const marker = editor.markBufferRange([
      [row, 0],
      [row, 0],
    ]);
    editor.decorateMarker(marker, {
      type: "line",
      class: "pulsar-assistant-follow-flash",
    });
    this.followMarker = marker;
    this.followFlashTimer = setTimeout(() => {
      this.followFlashTimer = null;
      marker.destroy();
      if (this.followMarker === marker) this.followMarker = null;
    }, 1200);
  }

  private updateAutoApproveButton(): void {
    this.autoApproveButton.setAttribute(
      "aria-pressed",
      String(this.autoApprovePermissions),
    );
    if (this.autoApprovePermissions) {
      this.autoApproveButton.textContent = "Permissions: Allow all";
      this.autoApproveButton.classList.add(
        "pulsar-assistant-auto-approve--on",
      );
    } else {
      this.autoApproveButton.textContent = "Permissions: Ask";
      this.autoApproveButton.classList.remove(
        "pulsar-assistant-auto-approve--on",
      );
    }
  }

  private expandPanel(panel: HTMLElement): void {
    panel.style.display = "";
    const delta = panel.offsetHeight;
    this.conversation.scrollTop += delta;
  }

  private collapsePanel(panel: HTMLElement): void {
    const delta = panel.offsetHeight;
    const savedScrollTop = this.conversation.scrollTop;
    panel.style.display = "none";
    void this.conversation.offsetHeight;
    this.conversation.scrollTop = Math.max(0, savedScrollTop - delta);
  }

  private openInfoPanel(): void {
    this.setInfoPanelOpen(true);
  }

  private setInfoPanelOpen(open: boolean): void {
    if (open && !this.storedAgentInfo && !this.agentExited) return;
    if (open === this.infoPanelOpen) {
      if (open) this.renderInfoPanel();
      return;
    }
    this.infoPanelOpen = open;
    if (open) {
      this.renderInfoPanel();
      this.expandPanel(this.infoPanel);
    } else {
      this.collapsePanel(this.infoPanel);
    }
    this.infoButton.setAttribute("aria-expanded", String(this.infoPanelOpen));
  }

  private renderPill(): void {
    const info = this.storedAgentInfo;
    const hasPanel = info != null || this.agentExited;
    this.infoButton.style.display = hasPanel ? "" : "none";
    this.renderLiveRow();
  }

  private renderInfoPanel(): void {
    this.infoPanel.innerHTML = "";
    const info = this.storedAgentInfo;
    const caps = this.storedCapabilities;

    const header = document.createElement("div");
    header.classList.add("pulsar-assistant-info-header");
    const title = document.createElement("span");
    title.classList.add("pulsar-assistant-info-title");
    title.textContent = "Agent details";
    const actions = document.createElement("div");
    actions.classList.add("pulsar-assistant-info-actions");
    actions.appendChild(this.restartButton);
    header.appendChild(title);
    header.appendChild(actions);
    this.infoPanel.appendChild(header);

    const addRow = (label: string, content: HTMLElement | string): void => {
      const row = document.createElement("div");
      row.classList.add("pulsar-assistant-info-row");
      const lbl = document.createElement("span");
      lbl.classList.add("pulsar-assistant-info-label");
      lbl.textContent = label;
      row.appendChild(lbl);
      if (typeof content === "string") {
        const val = document.createElement("span");
        val.classList.add("pulsar-assistant-info-value");
        val.textContent = content;
        row.appendChild(val);
      } else {
        row.appendChild(content);
      }
      this.infoPanel.appendChild(row);
    };

    const infoTable = (value: unknown): HTMLElement | null => {
      const rows = flattenInfoRows(value);
      if (rows.length === 0) return null;
      const wrap = document.createElement("div");
      wrap.classList.add("pulsar-assistant-info-table");
      const table = document.createElement("table");
      const body = document.createElement("tbody");
      for (const item of rows) {
        const row = document.createElement("tr");
        const key = document.createElement("td");
        key.classList.add("pulsar-assistant-info-key");
        key.textContent = item.key;
        const val = document.createElement("td");
        val.classList.add("pulsar-assistant-info-table-value");
        val.textContent = item.value;
        row.appendChild(key);
        row.appendChild(val);
        body.appendChild(row);
      }
      table.appendChild(body);
      wrap.appendChild(table);
      return wrap;
    };

    if (!info) {
      const statusContent = document.createElement("div");
      statusContent.classList.add("pulsar-assistant-info-version");
      const statusValue = document.createElement("span");
      statusValue.classList.add("pulsar-assistant-info-value");
      statusValue.textContent = this.lifecycleStatus || "Not connected.";
      statusContent.appendChild(statusValue);
      addRow("Status", statusContent);
      return;
    }

    const agentName = info.title || info.name;
    if (agentName) addRow("Agent", agentName);

    const modelId = this.currentModelId();
    if (modelId) addRow("Model", modelId);
    const modelDescription = this.currentModelDescription();
    if (modelDescription) addRow("Model description", modelDescription);

    const versionValue = document.createElement("span");
    versionValue.classList.add("pulsar-assistant-info-value");
    versionValue.textContent = info.version;
    const versionContent = document.createElement("div");
    versionContent.classList.add("pulsar-assistant-info-version");
    versionContent.appendChild(versionValue);
    addRow("Version", versionContent);

    addRow("Capabilities", caps ? (infoTable(caps) ?? "none reported") : "none reported");

    const meta = info._meta;
    if (meta && Object.keys(meta).length > 0) {
      const table = infoTable(meta);
      if (table) addRow("Meta", table);
    }
  }

  private send(): void {
    if (this.isComposerBusy()) return;
    this.closeSlashMenu();
    this.hideSlashHint();
    void this.sendPrompt();
  }

  private buildSlashComposer(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.classList.add("pulsar-assistant-slash-wrap");

    this.slashMenu = document.createElement("div");
    this.slashMenu.classList.add(
      "pulsar-assistant-picker-menu",
      "pulsar-assistant-slash-menu",
    );
    this.slashMenu.id = this.slashMenuId;
    this.slashMenu.setAttribute("role", "listbox");
    this.slashMenu.setAttribute("aria-label", "Slash commands");
    this.slashMenu.style.display = "none";

    this.slashHint = document.createElement("div");
    this.slashHint.classList.add("pulsar-assistant-slash-hint");
    this.slashHint.style.display = "none";

    wrap.appendChild(this.slashMenu);
    wrap.appendChild(this.input);
    wrap.appendChild(this.slashHint);

    const onDocPointerDown = (event: MouseEvent) => {
      if (this.slashMenuOpen && !wrap.contains(event.target as Node)) {
        this.closeSlashMenu();
      }
    };
    document.addEventListener("mousedown", onDocPointerDown, true);
    this.subscriptions.add(
      new Disposable(() =>
        document.removeEventListener("mousedown", onDocPointerDown, true),
      ),
    );
    return wrap;
  }

  private isComposerBusy(): boolean {
    return (
      this.session.running ||
      this.session.switching ||
      this.preparingPrompt ||
      this.permissionManager.isAwaitingAuth()
    );
  }

  private slashQuery(): string | null {
    const match = /^\/(\S*)$/.exec(this.input.value);
    return match ? match[1] : null;
  }

  private updateSlashMenu(): void {
    if (
      !this.slashHintCommand ||
      !this.input.value.startsWith(`/${this.slashHintCommand} `)
    ) {
      this.hideSlashHint();
    }
    const query = this.slashQuery();
    if (query === null || this.isComposerBusy()) {
      this.closeSlashMenu();
      return;
    }
    const lower = query.toLowerCase();
    const matches = this.session
      .currentAvailableCommands()
      .filter((command) => command.name.toLowerCase().startsWith(lower));
    if (matches.length === 0) {
      this.closeSlashMenu();
      return;
    }
    this.slashMatches = matches;
    this.slashActiveIndex = 0;
    this.slashMenuOpen = true;
    this.renderSlashMenu();
    this.slashMenu.style.display = "";
  }

  private renderSlashMenu(): void {
    this.slashMenu.innerHTML = "";
    this.slashMatches.forEach((command, index) => {
      const item = document.createElement("button");
      item.classList.add(
        "pulsar-assistant-picker-item",
        "pulsar-assistant-slash-item",
      );
      item.id = `${this.slashMenuId}-item-${index}`;
      item.setAttribute("role", "option");
      item.tabIndex = -1;

      const name = document.createElement("span");
      name.classList.add("pulsar-assistant-slash-name");
      name.textContent = `/${command.name}`;
      item.appendChild(name);
      if (command.description) {
        const desc = document.createElement("span");
        desc.classList.add("pulsar-assistant-slash-desc");
        desc.textContent = command.description;
        item.appendChild(desc);
      }
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.acceptSlashCommand(command);
      });
      this.slashMenu.appendChild(item);
    });
    this.applySlashActive();
  }

  private applySlashActive(): void {
    const items = Array.from(this.slashMenu.children) as HTMLElement[];
    items.forEach((item, index) => {
      const active = index === this.slashActiveIndex;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", active ? "true" : "false");
      if (active) item.scrollIntoView({ block: "nearest" });
    });
    this.input.setAttribute(
      "aria-activedescendant",
      `${this.slashMenuId}-item-${this.slashActiveIndex}`,
    );
  }

  private moveSlashActive(delta: number): void {
    const count = this.slashMatches.length;
    if (count === 0) return;
    this.slashActiveIndex = (this.slashActiveIndex + delta + count) % count;
    this.applySlashActive();
  }

  private handleSlashKeydown(event: KeyboardEvent): boolean {
    if (!this.slashMenuOpen || this.slashMatches.length === 0) return false;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.moveSlashActive(1);
        return true;
      case "ArrowUp":
        event.preventDefault();
        this.moveSlashActive(-1);
        return true;
      case "Enter":
      case "Tab":
        if (event.key === "Enter" && event.shiftKey) return false;
        event.preventDefault();
        this.acceptSlashCommand(this.slashMatches[this.slashActiveIndex]);
        return true;
      case "Escape":
        event.preventDefault();
        this.closeSlashMenu();
        return true;
      default:
        return false;
    }
  }

  private acceptSlashCommand(command: acp.AvailableCommand): void {
    this.closeSlashMenu();
    this.input.value = `/${command.name} `;
    this.input.focus();
    this.input.selectionStart = this.input.selectionEnd = this.input.value.length;
    if (command.description) this.showSlashHint(command.name, command.description);
  }

  private showSlashHint(commandName: string, description: string): void {
    this.slashHintCommand = commandName;
    this.slashHint.textContent = description;
    this.slashHint.style.display = "";
  }

  private hideSlashHint(): void {
    this.slashHintCommand = null;
    this.slashHint.textContent = "";
    this.slashHint.style.display = "none";
  }

  private closeSlashMenu(): void {
    if (!this.slashMenuOpen) return;
    this.slashMenuOpen = false;
    this.slashMatches = [];
    this.slashActiveIndex = 0;
    this.slashMenu.style.display = "none";
    this.slashMenu.innerHTML = "";
    this.input.removeAttribute("aria-activedescendant");
  }

  private async sendPrompt(): Promise<void> {
    const text = this.input.value.trim();
    const currentSession = this.session;
    let context: MaterializedContext[] = [];

    this.preparingPrompt = true;
    this.updateInputControls();
    try {
      context = await this.materializePendingContext();
      this.clearContext();
    } catch (error) {
      this.appendError(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      if (this.session === currentSession) {
        this.preparingPrompt = false;
        this.updateInputControls();
      }
    }

    if (text.length === 0 && context.length === 0) return;
    this.input.value = "";
    this.updateContextProgress();
    this.appendUserMessage(text, context);
    this.endStreamingBlocks();
    this.userEchoSkipCount++;
    this.sendButton.disabled = true;

    this.session
      .prompt(text, context)
      .catch((error) => {
        if (this.session !== currentSession) return;
        this.userEchoSkipCount--;
        this.appendError(error.message || String(error));
        this.setAgentStatus("error");
      })
      .finally(() => {
        if (this.session !== currentSession) return;
        this.stopButton.disabled = true;
        this.setGeneratingState(null);
        this.updateInputControls();
      });
  }

  private resetSessionForRelaunch(): void {
    this.subscriptions.remove(this.eventSubscription);
    this.session.dispose();
    this.session = new AgentSession(this.projectRoot);
    this.eventSubscription = this.session.onEvent((event) =>
      this.handleEvent(event),
    );
    this.subscriptions.add(this.eventSubscription);
    this.clearConversation();
    this.closeSlashMenu();
    this.hideSlashHint();
    this.contextControl.style.display = "none";
    this.resetAgentChrome();
    this.resetSessionsChrome();
    this.setAgentStatus("idle");
    this.renderLiveRow();
    this.stopButton.disabled = true;
    this.autoApprovePermissions = false;
    this.permissionManager.setAutoApprove(false);
    this.updateAutoApproveButton();
    this.setFollowAgent(false);
    this.userEchoSkipCount = 0;
  }

  private restart(): void {
    this.resetSessionForRelaunch();
    this.setLifecycleStatus("Idle \u2014 type a message to start the agent.");
    this.updateInputControls();
    this.ensureStarted();
  }

  private switchAgent(id: string): void {
    const config = readAgentsConfig();
    this.agentsConfig = config;
    const agent = config.agents[id];
    if (!agent) {
      this.renderAgentPicker();
      return;
    }
    let target: LaunchTarget;
    try {
      target = toLaunchTarget(id, agent);
    } catch (error) {
      this.appendError(error instanceof Error ? error.message : String(error));
      this.renderAgentPicker();
      return;
    }

    const launched = this.session.launchedAgent;
    const liveSameAgent =
      launchTargetsEqual(launched, target) &&
      this.session.sessionId != null &&
      !this.agentExited;
    if (liveSameAgent) {
      this.selectedAgentId = id;
      if (config.activeAgentId !== id) this.setActiveAgentId(id);
      this.renderAgentPicker();
      return;
    }

    if (this.session.running) {
      atom.confirm(
        {
          type: "warning",
          message: `Switch to ${agent.name}?`,
          detail:
            "The current agent is still responding. Switching stops it and clears this conversation.",
          buttons: ["Switch", "Cancel"],
          defaultId: 1,
        },
        (response) => {
          if (response === 0) this.performSwitch(target);
        },
      );
      return;
    }

    this.performSwitch(target);
  }

  private performSwitch(target: LaunchTarget): void {
    this.selectedAgentId = target.id;
    this.selectedModelId = target.kind === "openai" ? target.model : null;
    if (readAgentsConfig().activeAgentId !== target.id) {
      this.setActiveAgentId(target.id);
    }
    this.resetSessionForRelaunch();
    this.activeTarget = target;
    if (target.kind === "openai") {
      void this.fetchModelsForTarget(target);
    } else {
      this.modelList = null;
      this.modelsLoading = false;
      this.modelWarning = false;
      this.modelFetchController?.abort();
      this.modelFetchController = null;
      this.modelFetchGeneration++;
    }
    this.renderAgentPicker();
    this.renderModelSelector();
    this.setLifecycleStatus(`Starting ${target.name}\u2026`);
    this.updateInputControls();
    this.ensureStarted();
  }

  private setActiveAgentId(id: string): void {
    setActiveAgentId(id);
    this.agentsConfig = readAgentsConfig();
    this.selectedAgentId = id;
  }

  private pickerSelectedId(): string | null {
    const launched = this.session.launchedAgent;
    if (launched && !isLaunchedAgentStale(this.agentsConfig, launched.id)) {
      return launched.id;
    }
    return resolveAgent(this.agentsConfig, this.selectedAgentId).id ?? null;
  }

  private agentPickerLabel(): string {
    const launched = this.session.launchedAgent;
    if (launched) {
      return isLaunchedAgentStale(this.agentsConfig, launched.id)
        ? `${launched.name} (removed)`
        : launched.name;
    }
    const resolved = resolveAgent(this.agentsConfig, this.selectedAgentId);
    return resolved.agent ? resolved.agent.name : "Select agent\u2026";
  }

  private renderAgentPicker(): void {
    this.agentPicker.textContent = this.agentPickerLabel();
    const stale = isLaunchedAgentStale(
      this.agentsConfig,
      this.session.launchedAgent?.id,
    );
    this.agentPicker.classList.toggle("is-stale", stale);

    this.agentMenu.innerHTML = "";
    const groups = groupAgents(this.agentsConfig.agents);
    const selectedId = this.pickerSelectedId();
    for (const group of groups) {
      const header = document.createElement("div");
      header.classList.add("pulsar-assistant-picker-group");
      header.textContent = group.type === "openai" ? "API" : "ACP";
      this.agentMenu.appendChild(header);
      for (const [id, agent] of group.entries) {
        const item = document.createElement("button");
        item.classList.add("pulsar-assistant-picker-item");
        item.setAttribute("role", "menuitem");
        if (id === selectedId) {
          item.classList.add("is-active");
          item.setAttribute("aria-current", "true");
        }
        item.textContent = agent.name;
        item.addEventListener("click", () => {
          this.closeAgentMenu();
          this.switchAgent(id);
        });
        this.agentMenu.appendChild(item);
      }
    }
    if (groups.length === 0) {
      const empty = document.createElement("div");
      empty.classList.add("pulsar-assistant-picker-empty");
      empty.textContent = "No agents configured";
      this.agentMenu.appendChild(empty);
    }
  }

  private agentMenuItems(): HTMLButtonElement[] {
    return Array.from(
      this.agentMenu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
  }

  private focusAgentMenuItem(
    direction: "first" | "last" | "next" | "previous",
  ): void {
    const items = this.agentMenuItems();
    if (items.length === 0) return;
    const active = document.activeElement;
    const currentIndex = items.indexOf(active as HTMLButtonElement);
    let nextIndex = 0;
    if (direction === "last") {
      nextIndex = items.length - 1;
    } else if (direction === "next") {
      nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : 0;
    } else if (direction === "previous") {
      nextIndex =
        currentIndex >= 0
          ? (currentIndex - 1 + items.length) % items.length
          : items.length - 1;
    }
    items[nextIndex].focus();
  }

  private toggleAgentMenu(): void {
    if (this.agentMenuOpen) this.closeAgentMenu();
    else this.openAgentMenu();
  }

  private openAgentMenu(): void {
    this.renderAgentPicker();
    this.closeSettingsMenu();
    this.agentMenu.style.display = "";
    this.agentMenuOpen = true;
    this.agentPicker.setAttribute("aria-expanded", "true");
  }

  private closeAgentMenu(): void {
    this.agentMenu.style.display = "none";
    this.agentMenuOpen = false;
    this.agentPicker.setAttribute("aria-expanded", "false");
  }

  private toggleSettingsMenu(): void {
    if (this.settingsMenuOpen) this.closeSettingsMenu();
    else this.openSettingsMenu();
  }

  private openSettingsMenu(): void {
    this.closeAgentMenu();
    this.closeAllConfigMenus();
    this.settingsMenu.style.display = "";
    this.settingsMenuOpen = true;
    this.settingsButton.setAttribute("aria-expanded", "true");
  }

  private closeSettingsMenu(): void {
    this.settingsMenu.style.display = "none";
    this.settingsMenuOpen = false;
    this.settingsButton.setAttribute("aria-expanded", "false");
  }

  private openTestCommandModal(): void {
    const policy = readProjectPolicy(this.projectRoot);
    TestCommandModal.show({
      projectRoot: this.projectRoot,
      currentCommand: policy.testCommand,
      onSave: (command) => {
        setProjectTestCommand(this.projectRoot, command);
      },
    });
  }

  private resetSessionsChrome(): void {
    this.sessionTooltips.dispose();
    this.sessionTooltips = new CompositeDisposable();
    this.sessionsToggle.style.display = "none";
    this.newSessionButton.style.display = "none";
    const rows = this.sessionsList.querySelectorAll(".pulsar-assistant-session-row");
    rows.forEach((r) => r.remove());
    this.sessionsList.style.display = "none";
    this.knownSessions = [];
    this.sessionsListVisible = false;
    this.sessionsToggle.setAttribute("aria-expanded", "false");
    this.sessionConversationCache.clear();
    this.sessionLiveState.clear();
    this.planBarView.clearActivePlan();
  }

  private resetAgentChrome(): void {
    this.storedAgentInfo = null;
    this.storedCapabilities = null;
    this.currentTokens = null;
    this.agentExited = false;
    this.settingConfig.clear();
    this.modelFetchController?.abort();
    this.modelFetchController = null;
    this.modelFetchGeneration++;
    this.modelList = null;
    this.modelsLoading = false;
    this.modelWarning = false;
    this.renderLiveRow();
    this.renderConfigSelectors();
    this.renderModelSelector();
    this.renderPill();
    this.infoPanel.style.display = "none";
    this.infoPanel.innerHTML = "";
    this.infoPanelOpen = false;
    this.infoButton.setAttribute("aria-expanded", "false");
  }

  private finishAgentTeardown(statusText: string): void {
    this.endAwaitingAuth();
    this.setLifecycleStatus(statusText);
    this.setAgentStatus("error");
    this.openInfoPanel();
    this.resetSessionsChrome();
    this.stopButton.disabled = true;
    this.updateInputControls();
    this.endStreamingBlocks();
  }

  private clearConversation(): void {
    this.conversation.innerHTML = "";
    this.resetConversationState();
  }

  private resetConversationState(): void {
    this.toolCallManager.clear();
    this.permissionManager.clearSessionApprovedKinds();
    this.permissionManager.removeAuthCard();
    this.conversationTooltips.dispose();
    this.conversationTooltips = new CompositeDisposable();
    this.planBarView.clearActivePlan();
    this.preparingPrompt = false;
    this.clearContext();
    this.endStreamingBlocks();
    this.stickToBottom = true;
    this.generatingIndicator = null;
    this.statusBar.clear();
  }

  private startNewSession(): void {
    if (this.session.running || this.session.switching) return;
    this.setSessionsListVisible(false);
    this.stashActiveSessionLiveState();
    const currentId = this.session.sessionId;
    if (currentId) this.stashConversation(currentId);
    else this.clearConversation();
    this.resetLiveRow();
    this.permissionManager.setAutoApprove(false);
    this.autoApprovePermissions = false;
    this.updateAutoApproveButton();
    this.setFollowAgent(false);
    this.userEchoSkipCount = 0;
    this.session
      .newSession()
      .then(() => {
        this.input.focus();
        this.updateContextProgress();
      })
      .catch((error) => {
        if (currentId) this.rollbackConversation(currentId);
        this.appendError(error instanceof Error ? error.message : String(error));
      });
  }

  private switchToSession(id: string): void {
    if (this.session.running || this.session.switching) return;
    if (id === this.session.sessionId) return;
    this.setSessionsListVisible(false);
    this.stashActiveSessionLiveState();
    const currentId = this.session.sessionId;
    if (currentId) this.stashConversation(currentId);

    if (this.session.isSessionLoaded(id)) {
      this.resetConversationState();
      const cached = this.sessionConversationCache.get(id);
      if (cached !== undefined) this.swapInConversation(cached);
      this.planBarView.syncSession(id);
      this.session.activateCachedSession(id);
      this.restoreLiveState(id);
      this.permissionManager.setAutoApprove(false);
      this.autoApprovePermissions = false;
      this.updateAutoApproveButton();
      this.setFollowAgent(false);
      this.userEchoSkipCount = 0;
      this.input.focus();
      this.updateContextProgress();
      return;
    }

    this.showLoadingOverlay();
    this.resetConversationState();
    this.permissionManager.setAutoApprove(false);
    this.autoApprovePermissions = false;
    this.updateAutoApproveButton();
    this.setFollowAgent(false);
    this.userEchoSkipCount = 0;

    this.session
      .loadSession(id)
      .then(() => {
        this.hideLoadingOverlay();
        this.restoreLiveState(id);
        this.planBarView.syncSession(id);
        this.input.focus();
        this.updateContextProgress();
      })
      .catch((error) => {
        this.hideLoadingOverlay();
        if (currentId) this.rollbackConversation(currentId);
        this.appendError(error instanceof Error ? error.message : String(error));
      });
  }

  private stashConversation(id: string): void {
    this.planBarView.syncSession(id);
    this.sessionConversationCache.set(id, this.conversation);
    this.swapInFreshConversation();
  }

  private rollbackConversation(id: string): void {
    const prev = this.sessionConversationCache.get(id);
    if (prev) {
      this.swapInConversation(prev);
      this.planBarView.syncSession(id);
    }
  }

  private swapInFreshConversation(): void {
    const fresh = document.createElement("div");
    fresh.classList.add("pulsar-assistant-conversation");
    this.swapInConversation(fresh);
    this.resetConversationState();
  }

  private swapInConversation(node: HTMLElement): void {
    this.conversation.remove();
    this.conversation = node;
    this.conversationWrapper.insertBefore(
      this.conversation,
      this.loadingOverlay,
    );
    this.attachConversationScrollListener();
    this.stickToBottom = true;
    this.scrollToBottom();
  }

  private showLoadingOverlay(): void {
    this.loadingOverlay.style.display = "";
  }

  private hideLoadingOverlay(): void {
    this.loadingOverlay.style.display = "none";
  }

  private setGeneratingState(state: "working" | "awaiting" | "stopping" | null): void {
    if (!state) {
      this.generatingIndicator?.remove();
      this.generatingIndicator = null;
      return;
    }

    if (!this.generatingIndicator) {
      const el = document.createElement("div");
      el.classList.add("pulsar-assistant-generating");

      const icon = document.createElement("span");
      icon.classList.add("pulsar-assistant-generating-spinner");
      el.appendChild(icon);

      const label = document.createElement("span");
      label.classList.add("pulsar-assistant-generating-label");
      el.appendChild(label);

      this.generatingIndicator = el;
      this.conversation.appendChild(el);
    }

    const label = this.generatingIndicator.querySelector(
      ".pulsar-assistant-generating-label",
    );
    const messages = {
      working: "Working\u2026",
      awaiting: "Awaiting permission\u2026",
      stopping: "Stopping\u2026",
    };
    if (label) label.textContent = messages[state];
    this.scrollToBottom();
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "status":
        this.setLifecycleStatus(event.text);
        break;
      case "status-note":
        this.statusBar.setText(event.text);
        break;
      case "thought":
        this.statusBar.setText(event.text);
        break;
      case "initialized":
        this.storedAgentInfo = event.info;
        this.storedCapabilities = event.capabilities;
        this.agentExited = false;
        this.renderPill();
        this.contextControl.style.display = event.supportsImages ? "" : "none";
        this.refreshContextMenuItems();
        break;
      case "ready":
        this.hideLoadingOverlay();
        this.setAgentStatus(this.modelWarning ? "warning" : "ready");
        this.agentExited = false;
        this.setLifecycleStatus("");
        this.renderSessionControls();
        this.renderConfigSelectors();
        this.renderModelSelector();
        this.updateContextProgress();
        this.updateInputControls();
        break;
      case "turn-start":
        this.closeSlashMenu();
        this.planBarView.clearCompletedActivePlanEntries();
        this.setAgentStatus("working");
        this.stopButton.disabled = false;
        this.setGeneratingState("working");
        this.updateInputControls();
        this.updateSessionControls();
        this.statusBar.clear();
        break;
      case "turn-end":
        this.setAgentStatus(this.modelWarning ? "warning" : "ready");
        this.stopButton.disabled = true;
        this.setGeneratingState(null);
        this.updateInputControls();
        this.updateSessionControls();
        this.endStreamingBlocks();
        this.planBarView.snapshotCompletedPlan();
        if (event.stopReason && event.stopReason !== "end_turn") {
          this.appendNote(`Turn stopped: ${event.stopReason}`);
        }
        this.session.refreshSessionList();
        this.updateContextProgress();
        this.statusBar.clear();
        break;
      case "update":
        this.handleUpdate(event.sessionId, event.update);
        break;
      case "permission":
        this.permissionManager.renderPermission(
          this.conversation,
          event.params,
          event.respond,
        );
        break;
      case "auth-required":
        this.permissionManager.renderAuthPicker(
          this.conversation,
          event.methods,
          event.respond,
        );
        this.setAgentStatus("awaiting");
        this.setLifecycleStatus("Agent authentication required.");
        this.updateInputControls();
        this.updateSessionControls();
        break;
      case "permissions-cancelled":
        this.permissionManager.markPendingPermissionsCancelled(this.conversation);
        break;
      case "file-written":
        break;
      case "session-list":
        this.knownSessions = event.sessions;
        this.renderSessionsList();
        break;
      case "stderr":
        break;
      case "error":
        this.setAgentStatus("error");
        this.appendError(event.message);
        break;
      case "exit":
        this.agentExited = true;
        this.currentTokens = null;
        this.renderLiveRow();
        this.finishAgentTeardown(
          event.code !== null
            ? `Agent exited with code ${event.code}.`
            : event.signal !== null
              ? `Agent exited with signal ${event.signal}.`
              : "Agent exited.",
        );
        break;
    }
  }

  private handleUpdate(
    sessionId: acp.SessionId,
    update: acp.SessionUpdate,
  ): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendChunk("agent", update.messageId, update.content);
        break;
      case "agent_thought_chunk":
        this.appendChunk("thought", update.messageId, update.content);
        break;
      case "user_message_chunk":
        this.appendChunk("user", update.messageId, update.content);
        break;
      case "tool_call":
      case "tool_call_update":
        this.toolCallManager.renderToolCall(this.conversation, update as ToolUpdate);
        if (
          update.sessionUpdate === "tool_call_update" &&
          (update.status === "completed" || update.status === "failed")
        ) {
          this.updateContextProgress();
        }
        break;
      case "plan":
        this.planBarView.setActivePlan(update.entries || [], sessionId);
        break;
      case "config_option_update":
        this.renderConfigSelectors();
        break;
      case "available_commands_update":
        this.updateSlashMenu();
        break;
      case "usage_update":
        if (
          typeof update.used === "number" &&
          typeof update.size === "number"
        ) {
          this.currentTokens = `${update.used}\u202f/\u202f${update.size} tokens`;
          this.rememberLiveState(sessionId, this.currentTokens);
          this.renderLiveRow();
        }
        break;
      case "session_info_update":
        this.applySessionInfoUpdate(sessionId, update);
        break;
    }
  }

  private contentToText(content: acp.ContentBlock | null | undefined): string {
    if (!content) return "";
    switch (content.type) {
      case "text":
        return content.text || "";
      case "resource_link":
        return content.uri
          ? `[${content.name || content.uri}](${content.uri})`
          : content.name || "";
      case "resource":
        return "[resource]";
      case "image":
        return "[image]";
      case "audio":
        return "[audio]";
      default:
        return "";
    }
  }

  private appendChunk(
    role: string,
    messageId: acp.MessageId | null | undefined,
    content: acp.ContentBlock,
  ): void {
    const text = this.contentToText(content);
    if (!text) return;
    if (role === "user" && this.userEchoSkipCount > 0) {
      this.userEchoSkipCount--;
      return;
    }
    const streamMessageId = messageId ?? null;
    if (
      this.streamRole !== role ||
      this.streamMessageId !== streamMessageId ||
      !this.streamBody
    ) {
      this.endStreamingBlocks();
      this.streamBody = this.appendMessage(role, "");
      this.streamRole = role;
      this.streamMessageId = streamMessageId;
    }
    this.streamRawText += text;
    this.scheduleStreamRender();
    this.scrollToBottom();
  }

  private scheduleStreamRender(): void {
    if (this.streamRenderHandle !== null) return;
    this.streamRenderHandle = requestAnimationFrame(() => {
      this.streamRenderHandle = null;
      this.flushStreamRender();
    });
  }

  private flushStreamRender(): void {
    if (!this.streamBody) return;
    this.renderMarkdown(this.streamBody, this.streamRawText);
    this.scrollToBottom();
  }

  private endStreamingBlocks(): void {
    if (this.streamRenderHandle !== null) {
      cancelAnimationFrame(this.streamRenderHandle);
      this.streamRenderHandle = null;
    }
    if (this.streamBody && this.streamRawText) {
      this.renderMarkdown(this.streamBody, this.streamRawText);
      this.scrollToBottom();
    }
    this.streamRole = null;
    this.streamMessageId = null;
    this.streamBody = null;
    this.streamRawText = "";
  }

  private renderMarkdown(el: HTMLElement, text: string): void {
    renderMarkdownHtml(el, text);
    el.classList.add("pulsar-assistant-markdown");
  }

  private appendMessage(role: string, text: string): HTMLElement {
    const message = document.createElement("div");
    message.classList.add(
      "pulsar-assistant-message",
      `pulsar-assistant-message--${role}`,
    );

    const label = document.createElement("div");
    label.classList.add("pulsar-assistant-message-role");
    const labels: Record<string, string> = {
      user: "You",
      agent: "Agent",
      thought: "Thinking",
      note: "Note",
    };
    label.textContent = labels[role] || role;

    const body = document.createElement("div");
    body.classList.add("pulsar-assistant-message-body");
    body.textContent = text;

    message.appendChild(label);
    message.appendChild(body);
    this.conversation.appendChild(message);
    this.scrollToBottom();
    return body;
  }

  private appendUserMessage(
    text: string,
    context: MaterializedContext[] = [],
  ): void {
    const body = this.appendMessage("user", text);
    this.renderMarkdown(body, text);
    if (context.length > 0) {
      const strip = document.createElement("div");
      strip.classList.add("pulsar-assistant-message-context");
      for (const item of context) {
        strip.appendChild(this.makeContextChip(item.kind, item.label));
      }
      body.appendChild(strip);
    }
  }

  private buildContextControl(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.classList.add("pulsar-assistant-config", "pulsar-assistant-context");
    wrapper.style.display = "none";
    this.contextControl = wrapper;

    const menu = document.createElement("div");
    menu.classList.add("pulsar-assistant-config-menu");
    menu.setAttribute("role", "menu");
    menu.style.display = "none";
    this.contextMenu = menu;

    this.addSelectionItem = this.makeContextMenuItem(
      "Current selection",
      "icon-code",
      () => {
        void this.addSelectionContext(
          atom.workspace.getCenter().getActiveTextEditor(),
        );
      },
    );
    this.addFileItem = this.makeContextMenuItem(
      "Current file",
      "icon-file",
      () => {
        void this.addActiveFileContext(
          atom.workspace.getCenter().getActiveTextEditor(),
        );
      },
    );
    menu.appendChild(this.addSelectionItem);
    menu.appendChild(this.addFileItem);

    const trigger = document.createElement("button");
    trigger.classList.add(
      "btn",
      "icon",
      "icon-plus",
      "pulsar-assistant-context-trigger",
    );
    trigger.setAttribute("aria-label", "Attach to prompt");
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    this.subscriptions.add(
      atom.tooltips.add(trigger, {
        title: "Attach to prompt",
        placement: "top",
        trigger: "hover",
      }),
    );
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleContextMenu();
    });
    this.contextTrigger = trigger;

    wrapper.appendChild(menu);
    wrapper.appendChild(trigger);

    const onDocClick = (event: MouseEvent) => {
      if (this.contextMenuVisible && !wrapper.contains(event.target as Node))
        this.closeContextMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.contextMenuVisible) {
        this.closeContextMenu();
        trigger.focus();
      }
    };
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    this.subscriptions.add({
      dispose: () => {
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKeyDown);
      },
    });

    return wrapper;
  }

  private makeContextMenuItem(
    label: string,
    iconClass: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const item = document.createElement("button");
    item.classList.add("pulsar-assistant-config-item");
    item.setAttribute("role", "menuitem");
    const icon = document.createElement("span");
    icon.classList.add("icon", iconClass);
    item.appendChild(icon);
    const name = document.createElement("span");
    name.classList.add("pulsar-assistant-config-name");
    name.textContent = label;
    item.appendChild(name);
    item.addEventListener("click", () => {
      this.closeContextMenu();
      onClick();
    });
    return item;
  }

  private toggleContextMenu(): void {
    if (this.contextMenuVisible) this.closeContextMenu();
    else this.openContextMenu();
  }

  private openContextMenu(): void {
    if (this.contextTrigger.disabled) return;
    this.closeAllConfigMenus();
    this.refreshContextMenuItems();
    this.contextMenuVisible = true;
    this.contextMenu.style.display = "";
    this.contextTrigger.setAttribute("aria-expanded", "true");
  }

  private closeContextMenu(): void {
    if (!this.contextMenuVisible) return;
    this.contextMenuVisible = false;
    this.contextMenu.style.display = "none";
    this.contextTrigger.setAttribute("aria-expanded", "false");
  }

  private refreshContextMenuItems(): void {
    const editor = atom.workspace.getCenter().getActiveTextEditor();
    const hasFile = !!editor && !!editor.getPath();
    const embedded = this.session.supportsEmbeddedContext();

    this.addSelectionItem.style.display = embedded ? "" : "none";
    this.addSelectionItem.disabled =
      !hasFile || !editor || !this.lastNonEmptySelection(editor);

    this.addFileItem.style.display = embedded ? "" : "none";
    this.addFileItem.disabled = !hasFile;

    const anyEnabled =
      embedded && (!this.addSelectionItem.disabled || !this.addFileItem.disabled);
    this.contextTrigger.disabled = !anyEnabled;
  }

  private lastNonEmptySelection(editor: TextEditor): string | null {
    const selections = editor.getSelections();
    for (let i = selections.length - 1; i >= 0; i--) {
      const text = selections[i].getText();
      if (text.length > 0) return text;
    }
    return null;
  }

  async addSelectionContext(editor?: TextEditor): Promise<void> {
    const targetEditor =
      editor || atom.workspace.getCenter().getActiveTextEditor();
    if (!targetEditor) return;
    const filePath = targetEditor.getPath();
    if (!filePath) return;
    if (!(await this.session.isPathInProjectRoots(filePath))) {
      this.appendError("Cannot attach file from outside the project.");
      return;
    }
    const range = targetEditor.getSelectedBufferRange();
    if (range.isEmpty()) return;
    const rangeText = `${range.start.row + 1}-${range.end.row + 1}`;
    this.pendingContext = this.pendingContext.filter((c) => {
      if (c.kind === "file" && c.path === filePath) return false;
      if (
        c.kind === "selection" &&
        c.path === filePath &&
        c.rangeText === rangeText
      )
        return false;
      return true;
    });
    this.pendingContext.push({ kind: "selection", path: filePath, rangeText });
    this.renderContextStrip();
  }

  async addActiveFileContext(editor?: TextEditor): Promise<void> {
    const targetEditor =
      editor || atom.workspace.getCenter().getActiveTextEditor();
    if (!targetEditor) return;
    const filePath = targetEditor.getPath();
    if (!filePath) return;
    if (!(await this.session.isPathInProjectRoots(filePath))) {
      this.appendError("Cannot attach file from outside the project.");
      return;
    }
    this.pendingContext = this.pendingContext.filter(
      (c) => !(c.path === filePath),
    );
    this.pendingContext.push({ kind: "file", path: filePath });
    this.renderContextStrip();
  }

  private clearContext(): void {
    this.pendingContext = [];
    this.renderContextStrip();
  }

  private removeContextItem(index: number): void {
    this.pendingContext.splice(index, 1);
    this.renderContextStrip();
  }

  private makeContextChip(kind: "file" | "selection", label: string): HTMLElement {
    const chip = document.createElement("span");
    chip.classList.add(
      "pulsar-assistant-context-chip",
      `pulsar-assistant-context-chip--${kind}`,
    );
    const icon = document.createElement("span");
    icon.classList.add(
      "icon",
      kind === "file" ? "icon-file" : "icon-code",
      "pulsar-assistant-context-chip-icon",
    );
    const labelSpan = document.createElement("span");
    labelSpan.classList.add("pulsar-assistant-context-chip-label");
    labelSpan.textContent = label;
    chip.appendChild(icon);
    chip.appendChild(labelSpan);
    return chip;
  }

  private renderContextStrip(): void {
    this.contextStrip.innerHTML = "";
    if (this.pendingContext.length === 0) {
      this.contextStrip.style.display = "none";
      return;
    }
    this.contextStrip.style.display = "";
    this.pendingContext.forEach((item, index) => {
      const label =
        item.kind === "file"
          ? path.basename(item.path)
          : `${path.basename(item.path)}:${item.rangeText}`;
      const chip = this.makeContextChip(item.kind, label);
      const remove = document.createElement("button");
      remove.classList.add(
        "pulsar-assistant-context-chip-remove",
        "icon",
        "icon-x",
      );
      remove.setAttribute("aria-label", `Remove ${label}`);
      remove.addEventListener("click", () => this.removeContextItem(index));
      chip.appendChild(remove);
      this.contextStrip.appendChild(chip);
    });
  }

  private async materializePendingContext(): Promise<MaterializedContext[]> {
    const result: MaterializedContext[] = [];
    for (const item of this.pendingContext) {
      if (!(await this.session.isPathInProjectRoots(item.path))) {
        throw new Error(
          `Attached file is no longer in project: ${item.path}`,
        );
      }
      const editor = this.findOpenEditorForPath(item.path);
      const baseName = path.basename(item.path);
      if (item.kind === "file") {
        const text = editor
          ? editor.getText()
          : await this.readFileFromDisk(item.path);
        result.push({
          kind: "file",
          label: baseName,
          uri: fileUri(item.path),
          text,
        });
      } else {
        const parts = item.rangeText.split("-").map(Number);
        const startLine = parts[0] - 1;
        const endLine = parts[1] - 1;
        let text: string;
        if (editor) {
          text = editor.getTextInBufferRange([
            [startLine, 0],
            [endLine + 1, 0],
          ]);
        } else {
          const allLines = (await this.readFileFromDisk(item.path)).split("\n");
          text = allLines.slice(startLine, endLine + 1).join("\n");
        }
        result.push({
          kind: "selection",
          label: `${baseName}:${item.rangeText}`,
          uri: fileUri(item.path, { start: parts[0], end: parts[1] }),
          text,
        });
      }
    }
    return result;
  }

  private findOpenEditorForPath(filePath: string): TextEditor | null {
    for (const editor of atom.workspace.getTextEditors()) {
      if (this.samePath(editor.getPath(), filePath)) return editor;
    }
    return null;
  }

  private samePath(a: string | undefined | null, b: string | undefined | null): boolean {
    if (!a || !b) return false;
    const resolvedA = path.resolve(a);
    const resolvedB = path.resolve(b);
    return process.platform === "win32"
      ? resolvedA.toLowerCase() === resolvedB.toLowerCase()
      : resolvedA === resolvedB;
  }

  private async readFileFromDisk(filePath: string): Promise<string> {
    const fs = await import("fs/promises");
    return fs.readFile(filePath, "utf8");
  }

  private async isOpenableFile(filePath: string): Promise<boolean> {
    if (!filePath || !path.isAbsolute(filePath)) return false;
    if (!(await this.session.isPathInProjectRoots(filePath))) return false;
    try {
      const fs = await import("fs/promises");
      const stat = await fs.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  private async openLocation(
    filePath: string,
    line?: number | null,
  ): Promise<void> {
    if (!(await this.isOpenableFile(filePath))) return;
    const editor = (await atom.workspace.open(filePath, {
      searchAllPanes: true,
      activatePane: true,
    })) as TextEditor | undefined;
    if (editor && typeof line === "number" && Number.isFinite(line)) {
      editor.setCursorBufferPosition([line, 0]);
      editor.scrollToCursorPosition({ center: true });
    }
  }

  private appendNote(text: string): void {
    this.appendMessage("note", text);
    this.scrollToBottom();
  }

  private appendError(text: string): void {
    const message = document.createElement("div");
    message.classList.add(
      "pulsar-assistant-message",
      `pulsar-assistant-message--error`,
    );
    message.textContent = text;
    this.conversation.appendChild(message);
    this.scrollToBottom();
  }

  private endAwaitingAuth(): void {
    if (!this.permissionManager.isAwaitingAuth()) return;
    this.permissionManager.removeAuthCard();
    this.setLifecycleStatus("");
    this.setAgentStatus(this.modelWarning ? "warning" : "ready");
    this.updateInputControls();
    this.updateSessionControls();
  }

  private renderSessionControls(): void {
    const canList = this.session.canListSessions();
    this.sessionsToggle.style.display = canList ? "" : "none";
    this.compactButton.style.display = this.session.sessionId ? "" : "none";
    this.newSessionButton.style.display = "";
    if (canList) this.session.refreshSessionList();
  }

  private updateSessionControls(): void {
    const busy = this.session.running || this.session.switching;
    this.sessionsToggle.disabled = busy;
    this.compactButton.disabled = busy;
    this.newSessionButton.disabled = busy;
  }

  private setSessionsListVisible(visible: boolean): void {
    this.sessionsListVisible = visible;
    this.sessionsToggle.setAttribute("aria-expanded", String(visible));
    this.sessionsList.style.display = visible ? "" : "none";
    if (visible) {
      this.renderSessionsList();
      this.session.refreshSessionList();
    }
  }

  private renderSessionsList(): void {
    this.sessionTooltips.dispose();
    this.sessionTooltips = new CompositeDisposable();

    const activeId = this.session.sessionId;
    const canDelete = this.session.canDeleteSession();
    const canLoad = this.session.canLoadSession();

    this.sessionsList.innerHTML = "";
    const header = document.createElement("div");
    header.classList.add("pulsar-assistant-sessions-header");
    header.textContent = "Sessions";
    this.sessionsList.appendChild(header);

    if (this.knownSessions.length === 0) {
      const empty = document.createElement("div");
      empty.classList.add("pulsar-assistant-sessions-empty");
      empty.textContent = "No sessions reported.";
      this.sessionsList.appendChild(empty);
      return;
    }

    for (const info of this.knownSessions) {
      const row = document.createElement("div");
      row.classList.add("pulsar-assistant-session-row");
      const isActive = info.sessionId === activeId;
      if (isActive) row.classList.add("is-active");

      const selectBtn = document.createElement("button");
      selectBtn.classList.add("pulsar-assistant-session-select");
      selectBtn.type = "button";
      if (isActive) selectBtn.setAttribute("aria-current", "true");

      const title = document.createElement("span");
      title.classList.add("pulsar-assistant-session-title");
      title.textContent = info.title || info.sessionId;
      selectBtn.appendChild(title);

      if (info.updatedAt) {
        const time = document.createElement("span");
        time.classList.add("pulsar-assistant-session-time");
        time.textContent = this.formatRelativeTime(info.updatedAt);
        selectBtn.appendChild(time);
      }

      if (canLoad && !isActive) {
        selectBtn.addEventListener("click", () => {
          this.switchToSession(info.sessionId);
        });
      } else {
        selectBtn.disabled = true;
      }
      row.appendChild(selectBtn);

      if (canDelete) {
        const deleteBtn = document.createElement("button");
        deleteBtn.classList.add(
          "pulsar-assistant-session-delete",
          "icon",
          "icon-trashcan",
        );
        deleteBtn.type = "button";
        deleteBtn.setAttribute("aria-label", "Delete session");
        this.sessionTooltips.add(
          atom.tooltips.add(deleteBtn, { title: "Delete session" }),
        );
        deleteBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          this.confirmDeleteSession(info);
        });
        row.appendChild(deleteBtn);
      }

      this.sessionsList.appendChild(row);
    }
  }

  private confirmDeleteSession(info: acp.SessionInfo): void {
    if (this.session.running || this.session.switching) return;
    const title = info.title || info.sessionId;
    atom.confirm(
      {
        type: "warning",
        message: `Delete session "${title}"?`,
        detail: "This cannot be undone.",
        buttons: ["Delete", "Cancel"],
        defaultId: 1,
      },
      (response) => {
        if (response === 0) this.performDeleteSession(info.sessionId, info.cwd);
      },
    );
  }

  private performDeleteSession(id: string, cwd?: string): void {
    this.sessionLiveState.delete(id);
    this.sessionConversationCache.delete(id);
    this.planBarView.removeSession(id);
    const wasActive = id === this.session.sessionId;
    this.session
      .deleteSession(id, cwd)
      .then(() => {
        if (wasActive) {
          this.startNewSession();
        }
      })
      .catch((error) => {
        this.appendError(error instanceof Error ? error.message : String(error));
      });
  }

  private applySessionInfoUpdate(
    sessionId: string,
    update: acp.SessionInfoUpdate,
  ): void {
    const existing = this.knownSessions.find((s) => s.sessionId === sessionId);
    if (existing) {
      if (update.title !== undefined) existing.title = update.title;
      if (update.updatedAt !== undefined) existing.updatedAt = update.updatedAt;
    } else {
      this.knownSessions.unshift({
        sessionId,
        cwd: this.projectRoot,
        title: update.title,
        updatedAt: update.updatedAt,
      });
    }
    if (this.sessionsListVisible) this.renderSessionsList();
  }

  private formatRelativeTime(isoString: string): string {
    const then = Date.parse(isoString);
    if (Number.isNaN(then)) return "";
    const seconds = Math.floor((Date.now() - then) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  private stashActiveSessionLiveState(): void {
    const id = this.session.sessionId;
    if (id) this.rememberLiveState(id, this.currentTokens);
  }

  private rememberLiveState(sessionId: string, tokens: string | null): void {
    this.sessionLiveState.set(sessionId, tokens);
  }

  private restoreLiveState(sessionId: string): void {
    this.currentTokens = this.sessionLiveState.get(sessionId) ?? null;
    this.renderLiveRow();
  }

  private resetLiveRow(): void {
    this.currentTokens = null;
    this.renderLiveRow();
  }

  private renderLiveRow(): void {
    const pieces: string[] = [];
    if (this.lifecycleStatus) pieces.push(this.lifecycleStatus);
    if (this.currentTokens) pieces.push(this.currentTokens);
    this.liveStatusEl.textContent = pieces.join(" \u2014 ");
  }

  private updateLiveStatusTraffic(): void {
    this.renderLiveRow();
  }

  private attachConversationScrollListener(): void {
    this.conversation.addEventListener("scroll", () => {
      const atBottom =
        this.conversation.scrollHeight -
          this.conversation.scrollTop -
          this.conversation.clientHeight <
        20;
      this.stickToBottom = atBottom;
      this.updateScrollToBottomButton();
    });
  }

  private updateScrollToBottomButton(): void {
    this.scrollToBottomButton.style.display = this.stickToBottom ? "none" : "";
  }

  private scrollToBottom(): void {
    if (!this.stickToBottom) return;
    this.conversation.scrollTop = this.conversation.scrollHeight;
  }

  private setLifecycleStatus(text: string): void {
    this.lifecycleStatus = text;
    this.renderLiveRow();
    if (this.infoPanelOpen) this.renderInfoPanel();
  }

  private setAgentStatus(status: AgentStatus): void {
    this.element.dataset.agentStatus = status;
    this.statusReporter?.report(this, status, this.activeAgentName);
  }

  private updateInputControls(): void {
    const busy = this.isComposerBusy();
    this.input.disabled = busy;
    this.sendButton.disabled = busy || this.input.value.trim().length === 0;
    this.updateConfigSelectorsDisabled();
    this.refreshContextMenuItems();
    this.contextTrigger.disabled = busy || this.contextTrigger.disabled;
  }

  ensureStarted(): void {
    this.isShown = true;
    const target = this.activeTarget;
    if (!target) {
      this.renderNoAgentIdle();
      return;
    }
    this.setLifecycleStatus(`Starting ${target.name}\u2026`);
    this.updateInputControls();
    this.session
      .start(target)
      .then(() => {
        this.updateContextProgress();
      })
      .catch((error) => {
        if (!isStartupCancellation(error)) {
          this.handleStartupError(error);
        }
      });
  }

  private async compactContext(): Promise<void> {
    const sessionId = this.session.sessionId;
    if (!sessionId) return;
    try {
      const result = await this.session.compactContext(sessionId);
      if (result.compactedCount > 0) {
        this.statusBar.setText(
          `Compacted ${result.compactedCount} tool result${result.compactedCount === 1 ? "" : "s"} in conversation context.`,
          5000,
        );
      } else {
        this.statusBar.setText(
          "No tool results to compact in current context.",
          4000,
        );
      }
      this.updateContextProgress();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.statusBar.setText(`Failed to compact context: ${msg}`, 5000);
    }
  }

  destroy(): void {
    this.statusReporter?.clear(this);
    this.permissionManager.removeAuthCard();
    this.toolCallManager.clear();
    this.statusBar.clear();
    this.clearFollowEffects();
    this.subscriptions.dispose();
    this.conversationTooltips.dispose();
    this.sessionTooltips.dispose();
    this.session.dispose();
    this.element.remove();
  }
}
