import { CompositeDisposable, Disposable, DisplayMarker, TextEditor } from "atom";
import * as fs from "fs";
import * as path from "path";
import * as acp from "@agentclientprotocol/sdk";
import {
  AgentEvent,
  AgentSession,
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
  completedPlanEntries,
  fileUri,
  flattenInfoRows,
  nextTurnActivePlanEntries,
  selectionLineRange,
} from "../util";
import {
  CFG_NS,
  readAgentsConfig,
  readProjectPolicy,
  setActiveAgentId,
  setProjectMaxTurnRequests,
} from "./config-store";
import { ConfigSelector, SelectConfigOption } from "./config-selector";
import { renderMarkdown as renderMarkdownHtml } from "./markdown";
import { ModelSelector } from "./model-selector";
import { fetchOpenAiModels, OpenAiModelInfo } from "../openai-client";
import { projectFolderName, uriForProject } from "../project-uri";

const TEXT_NODE_TYPE = 3;
let nextAgentMenuId = 1;

export type AgentStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "working"
  | "awaiting"
  | "warning"
  | "error";

export interface AgentStatusReporter {
  report(
    view: PulsarAssistantView,
    status: AgentStatus,
    name: string | null,
  ): void;
  clear(view: PulsarAssistantView): void;
}

type DockLocation = "left" | "right" | "bottom";

type ToolUpdate = Extract<
  acp.SessionUpdate,
  { sessionUpdate: "tool_call" | "tool_call_update" }
>;

type ToolView = {
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
};

type ContextKind = "file" | "selection";

// A staged editor-context attachment shown as a chip below the input. For a
// file we hold the editor ref and re-read its text at send (capturing unsaved
// edits); for a selection we snapshot the selected text at attach time.
type PendingContext = {
  id: number;
  kind: ContextKind;
  uri: string;
  label: string;
  path: string;
  editor?: TextEditor;
  text?: string;
};

// An attachment that survived send-time validation, ready to inline and echo.
type MaterializedContext = {
  uri: string;
  text: string;
  kind: ContextKind;
  label: string;
};

// In-flight lock key, scoped per session so an option set in one session can't
// disable the same-id option in another.
function configLockKey(sessionId: string | null, configId: string): string {
  return `${sessionId}\u0000${configId}`;
}

export class PulsarAssistantView {
  element!: HTMLElement;
  private subscriptions: CompositeDisposable;
  private session: AgentSession;
  private eventSubscription!: { dispose: () => void };
  private toolViews = new Map<string, ToolView>();
  private activePlanEntries: acp.PlanEntry[] = [];
  private activePlanSessionId: string | null = null;
  private planExpanded = false;
  private streamRole: string | null = null;
  private streamMessageId: string | null = null;
  private streamBody: HTMLElement | null = null;
  private streamRawText = "";
  private streamRenderHandle: number | null = null;
  private userEchoSkipCount = 0;
  private stickToBottom = true;
  private lastUserScrollAt = 0;
  private pointerDownInConversation = false;
  private scrollBoundConversations = new WeakSet<HTMLElement>();

  private runtimeStatusEl!: HTMLElement;
  private liveStatusEl!: HTMLElement;
  private agentPicker!: HTMLButtonElement;
  private agentMenu!: HTMLElement;
  private readonly agentMenuId = `pulsar-assistant-picker-menu-${nextAgentMenuId++}`;
  private agentMenuOpen = false;
  private agentsConfig!: AgentsConfig;
  // Panel-local selection. Not written as a project list in config.cson;
  // serialized with the dock item. Global activeAgentId is only the default
  // for a newly opened panel.
  private selectedAgentId: string | undefined;
  // Panel-local model selection for `openai` agents. The registry's
  // `defaultModel` is only the default for a newly opened panel.
  private selectedModelId: string | null = null;
  private modelSelectorWrap!: HTMLElement;
  private modelSelector: ModelSelector | null = null;
  private modelList: OpenAiModelInfo[] | null = null;
  private modelsLoading = false;
  private modelWarning = false;
  private modelFetchGeneration = 0;
  private modelFetchController: AbortController | null = null;
  // Tool kinds approved for the current session from a permission prompt.
  private sessionApprovedKinds = new Set<string>();
  // The agent we last asked to launch (display snapshot + stale-detection id).
  private activeTarget: LaunchTarget | null = null;
  private infoButton!: HTMLButtonElement;
  private restartButton!: HTMLButtonElement;
  private infoPanel!: HTMLElement;
  private infoPanelOpen = false;
  private storedAgentInfo: acp.Implementation | null = null;
  private storedCapabilities: acp.AgentCapabilities | null = null;
  private currentTokens: string | null = null;
  private lifecycleStatus = "";
  private agentExited = false;
  private awaitingAuth = false;
  private authCard: HTMLElement | null = null;
  private input!: HTMLTextAreaElement;
  private maxTurnRequestsInput!: HTMLInputElement;
  private slashMenu!: HTMLElement;
  private slashHint!: HTMLElement;
  private readonly slashMenuId = `pulsar-assistant-slash-menu-${nextAgentMenuId++}`;
  private slashMenuOpen = false;
  private slashMatches: acp.AvailableCommand[] = [];
  private slashActiveIndex = 0;
  private slashHintCommand: string | null = null;
  private conversation!: HTMLElement;
  private conversationWrapper!: HTMLElement;
  private planBar!: HTMLElement;
  private loadingOverlay!: HTMLElement;
  private scrollToBottomButton!: HTMLButtonElement;
  private generatingIndicator: HTMLElement | null = null;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private autoApproveButton!: HTMLButtonElement;
  private autoApprovePermissions = false;
  private followButton!: HTMLButtonElement;
  private followAgent = false;
  private followGeneration = 0;
  private followTargetPath: string | null = null;
  private followTargetLine: number | null = null;
  private followPending: { path: string; line?: number | null } | null = null;
  private followTimer: ReturnType<typeof setTimeout> | null = null;
  private followFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private followMarker: DisplayMarker | null = null;
  private newSessionButton!: HTMLButtonElement;
  private sessionsToggle!: HTMLButtonElement;
  private sessionsList!: HTMLElement;
  private sessionTooltips = new CompositeDisposable();
  private conversationTooltips = new CompositeDisposable();
  private authTooltips = new CompositeDisposable();
  private sessionsListVisible = false;
  private knownSessions: acp.SessionInfo[] = [];
  private sessionConversationCache = new Map<string, HTMLElement>();
  private sessionLiveState = new Map<string, { tokens: string | null }>();
  private sessionPlanState = new Map<string, acp.PlanEntry[]>();
  private configSelectorsContainer!: HTMLElement;
  private configSelectors: ConfigSelector[] = [];
  private settingConfig = new Set<string>();

  private preparingPrompt = false;
  private pendingContext: PendingContext[] = [];
  private nextContextId = 1;
  private contextStrip!: HTMLElement;
  private contextTooltips = new CompositeDisposable();
  private contextControl!: HTMLElement;
  private contextMenu!: HTMLElement;
  private contextTrigger!: HTMLButtonElement;
  private contextMenuVisible = false;
  private addSelectionItem!: HTMLButtonElement;
  private addFileItem!: HTMLButtonElement;
  private startObserver: IntersectionObserver | null = null;
  private startAttempted = false;
  private reporter: AgentStatusReporter | null;

  constructor(
    readonly projectRoot: string,
    reporter: AgentStatusReporter | null = null,
    options: { selectedAgentId?: string; selectedModelId?: string } = {},
  ) {
    this.reporter = reporter;
    this.selectedAgentId = options.selectedAgentId;
    this.selectedModelId = options.selectedModelId ?? null;
    this.subscriptions = new CompositeDisposable();
    this.agentsConfig = readAgentsConfig();
    this.session = new AgentSession(projectRoot);
    this.userEchoSkipCount = 0;

    this.buildUI();
    this.eventSubscription = this.session.onEvent((event) =>
      this.handleEvent(event),
    );
    this.subscriptions.add(this.eventSubscription);
    this.subscriptions.add(
      atom.config.onDidChange(CFG_NS, () => this.refreshFromConfig()),
    );
    this.renderAgentPicker();
    this.renderModelSelector();
    this.refreshTurnLimitInput();
    this.setLifecycleStatus("Idle \u2014 type a message to start the agent.");
    this.setAgentStatus("idle");

    // Start the agent only once the panel is actually shown. A dock restored
    // collapsed at editor startup should not spawn the agent until the user
    // opens it. ensureStarted() also runs on the first prompt as a fallback.
    this.observeStartOnVisible();
  }

  private observeStartOnVisible(): void {
    if (typeof IntersectionObserver === "undefined") {
      this.ensureStarted();
      return;
    }
    this.startObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.disconnectStartObserver();
        this.ensureStarted();
      }
    });
    this.startObserver.observe(this.element);
  }

  private disconnectStartObserver(): void {
    this.startObserver?.disconnect();
    this.startObserver = null;
  }

  private ensureStarted(): void {
    this.disconnectStartObserver();
    this.startAttempted = true;
    const target = this.resolveTarget();
    if (!target) {
      this.renderNoAgentIdle();
      return;
    }
    this.activeTarget = target;
    this.renderAgentPicker();
    this.startTarget(target);
  }

  private startTarget(target: LaunchTarget): void {
    this.disconnectStartObserver();
    this.activeTarget = target;
    this.renderAgentPicker();
    this.syncModelSelectorForTarget(target);
    const currentSession = this.session;
    this.session.start(target).catch((error) => {
      if (this.session !== currentSession) return;
      if (isStartupCancellation(error)) return;
      this.handleStartupError(error);
    });
  }

  // STRICT launch resolution from the latest config. Returns null when no agent
  // is launchable (caller shows a neutral idle state — never auto-guesses).
  private resolveTarget(): LaunchTarget | null {
    this.agentsConfig = readAgentsConfig();
    const resolved = resolveAgent(this.agentsConfig, this.selectedAgentId);
    if (resolved.reason === "ok" && resolved.agent && resolved.id) {
      try {
        return toLaunchTarget(
          resolved.id,
          resolved.agent,
          process.env,
          this.selectedModelId ?? undefined,
        );
      } catch (error) {
        this.appendError(error instanceof Error ? error.message : String(error));
        return null;
      }
    }
    return null;
  }

  private syncModelSelectorForTarget(target: LaunchTarget): void {
    if (target.kind === "openai") {
      if (!this.selectedModelId) this.selectedModelId = target.model;
      this.renderModelSelector();
      void this.fetchModelsForTarget(target);
      return;
    }
    this.modelSelector?.closeMenu();
    this.renderModelSelector();
  }

  private renderModelSelector(): void {
    if (!this.modelSelector || !this.modelSelectorWrap) return;
    const target = this.activeTarget;
    if (target?.kind !== "openai") {
      this.modelSelector.closeMenu();
      this.modelSelectorWrap.style.display = "none";
      return;
    }
    this.modelSelectorWrap.style.display = "";
    this.modelSelector.render(
      this.selectedModelId ?? target.model,
      this.modelList,
      this.modelsLoading,
    );
  }

  private modelSelectorDisabled(): boolean {
    return (
      this.session.running ||
      this.session.switching ||
      this.preparingPrompt ||
      this.awaitingAuth ||
      this.modelList == null ||
      this.modelsLoading
    );
  }

  private selectModel(id: string): void {
    if (this.modelSelectorDisabled()) return;
    const target = this.activeTarget;
    if (!target || target.kind !== "openai") return;
    const agent = this.agentsConfig.agents[target.id];
    if (!agent) return;
    let next: LaunchTarget;
    try {
      next = toLaunchTarget(target.id, agent, process.env, id);
    } catch (error) {
      this.appendError(error instanceof Error ? error.message : String(error));
      return;
    }
    this.performSwitch(next);
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
      if (this.infoPanelOpen) this.renderInfoPanel();
    } catch (error) {
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
    // Focusable so a mouse selection focuses the panel and core:copy dispatches
    // from inside it (bubbling up to the handler), not from body. Matches
    // Markdown Preview.
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
    // Close the menu when clicking anywhere outside the picker.
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
        this.closeAllConfigMenus();
      },
    );
    this.modelSelectorWrap.appendChild(this.modelSelector.element);
    row1.appendChild(this.modelSelectorWrap);

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
    rightGroup.appendChild(this.sessionsToggle);
    rightGroup.appendChild(this.newSessionButton);

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

    // Wrap the conversation so the loading overlay can cover just this region
    // (not the header or footer) while history is replayed.
    this.conversationWrapper = document.createElement("div");
    this.conversationWrapper.classList.add("pulsar-assistant-conversation-wrapper");

    this.planBar = document.createElement("div");
    this.planBar.classList.add("pulsar-assistant-plan-bar");
    this.planBar.style.display = "none";

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
      if (event.isComposing || event.keyCode === 229) return; // IME composing
      if (this.handleSlashKeydown(event)) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    this.input.addEventListener("input", () => this.updateSlashMenu());

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
    actions.appendChild(this.autoApproveButton);

    const actionButtons = document.createElement("div");
    actionButtons.classList.add("pulsar-assistant-action-buttons");
    actionButtons.appendChild(this.followButton);
    actionButtons.appendChild(this.stopButton);
    actionButtons.appendChild(this.sendButton);

    footer.appendChild(this.contextStrip);
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
    this.element.appendChild(this.planBar);
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
    this.maxTurnRequestsInput.max = "100";
    this.maxTurnRequestsInput.step = "1";
    this.maxTurnRequestsInput.placeholder = "20";
    this.maxTurnRequestsInput.addEventListener("change", () => {
      this.saveTurnLimit();
    });

    this.subscriptions.add(
      atom.tooltips.add(wrap, {
        title:
          "Maximum tool calls in one turn for this project. Empty uses the default (20).",
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
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      this.refreshTurnLimitInput();
      this.appendError("Tool turns must be a whole number from 1 to 100.");
      return;
    }
    setProjectMaxTurnRequests(this.projectRoot, value);
    this.refreshTurnLimitInput();
  }

  private closeAllConfigMenus(): void {
    for (const selector of this.configSelectors) selector.closeMenu();
    this.modelSelector?.closeMenu();
  }

  private updateConfigSelectorsDisabled(): void {
    for (const selector of this.configSelectors) selector.updateDisabled();
  }

  private renderConfigSelectors(): void {
    const options = this.session.currentSessionConfigOptions();
    const selects = (options ?? []).filter(
      (o): o is SelectConfigOption => o.type === "select",
    );

    // Rebuild so the rendered selectors match the agent's current option list.
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
            configLockKey(this.session.sessionId, configId),
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
    const lockKey = configLockKey(sessionId, configId);
    if (this.session.switching || this.settingConfig.has(lockKey)) return;

    const previous = option.currentValue;
    // Optimistic update with revert on failure. Revert the captured option if
    // it still holds our value (even after a session switch); guard the error
    // and re-render on the active session so a switch or a concurrent
    // config_option_update can't desync the UI.
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

  // Drops a queued or in-flight follow open without touching the Follow toggle
  // or current highlight; the generation bump invalidates an open mid-await.
  private cancelPendingFollow(): void {
    this.followGeneration++;
    if (this.followTimer !== null) {
      clearTimeout(this.followTimer);
      this.followTimer = null;
    }
    this.followPending = null;
  }

  // Trailing-edge throttle: stream many updates, follow only the latest
  // location. Dedupe on path AND line so the current spot isn't re-opened per
  // streamed token, while a new line in the same file still re-centers.
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
    // Mark the target before awaiting open so the active-editor change the open
    // may trigger is recognized as our own and doesn't auto-unfollow.
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
      // A non-text item (e.g. an image opens as an ImageEditor) has no buffer
      // to scroll; skip it rather than crashing on a bad cast.
      !(editor instanceof TextEditor)
    ) {
      return;
    }
    // ACP line is 0-based, matching Atom's buffer rows; do not offset.
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
    // Reading offsetHeight forces a synchronous reflow so the scrollTop
    // correction lands in the same frame — no visual jump.
    const delta = panel.offsetHeight;
    this.conversation.scrollTop += delta;
  }

  private collapsePanel(panel: HTMLElement): void {
    // Capture both values before hiding so the browser can't clamp them first.
    const delta = panel.offsetHeight;
    const savedScrollTop = this.conversation.scrollTop;
    panel.style.display = "none";
    void this.conversation.offsetHeight; // force reflow
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

  // Runtime identity disclosure. Turn state lives in the status bar tile; token
  // usage shares this live row when the agent reports it for the active session.
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

    // No identity yet (agent exited before initializing): still surface Restart
    // so a failed start is recoverable from the UI.
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
      this.awaitingAuth
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
      // Permissive: leave closed so an unknown "/foo" falls through to send.
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
      // preventDefault keeps focus in the textarea; a click would blur it first.
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.acceptSlashCommand(command);
      });
      this.slashMenu.appendChild(item);
    });
    this.applySlashActive();
  }

  // Toggle the active row in place instead of rebuilding the list each keypress.
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
        if (event.shiftKey) return false;
        event.preventDefault();
        this.acceptSlashCommand(this.slashMatches[this.slashActiveIndex]);
        return true;
      case "Tab":
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
    if (command.input) {
      this.slashHintCommand = command.name;
      this.slashHint.textContent = command.input.hint;
      this.slashHint.style.display = "";
      return;
    }
    this.send();
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

  private hideSlashHint(): void {
    this.slashHintCommand = null;
    this.slashHint.style.display = "none";
    this.slashHint.textContent = "";
  }

  private async sendPrompt(): Promise<void> {
    const text = this.input.value.trim();
    if (
      (text.length === 0 && this.pendingContext.length === 0) ||
      this.isComposerBusy()
    )
      return;

    // A live session stays on its current agent — prompting never silently
    // switches (a hand-edited activeAgentId applies on the next Switch/Restart).
    // Only resolve from config when starting fresh or reconnecting after exit.
    const live = this.session.sessionId != null && !this.agentExited;
    let target: LaunchTarget | null = live ? this.session.currentTarget : null;
    if (!target) {
      target = this.resolveTarget();
      if (!target) {
        this.appendError(
          "No agent configured. Use the picker to add or select one.",
        );
        this.setAgentStatus("error");
        return;
      }
    }
    this.activeTarget = target;
    this.renderAgentPicker();
    if (!live) this.syncModelSelectorForTarget(target);

    const currentSession = this.session;
    this.preparingPrompt = true;
    this.updateInputControls();
    let context: MaterializedContext[] = [];
    try {
      await this.session.start(target);
      if (this.session !== currentSession || !this.preparingPrompt) return;
      context = await this.materializePendingContext();
      if (this.session !== currentSession || !this.preparingPrompt) return;
    } catch (error) {
      if (isStartupCancellation(error)) return;
      if (this.session === currentSession) {
        this.endAwaitingAuth();
        this.appendError(
          error instanceof Error ? error.message : String(error),
        );
        this.setAgentStatus("error");
      }
      return;
    } finally {
      if (this.session === currentSession) {
        this.preparingPrompt = false;
        this.updateInputControls();
      }
    }

    if (text.length === 0 && context.length === 0) return;
    this.input.value = "";
    this.appendUserMessage(text, context);
    this.endStreamingBlocks();
    // Track that we expect an echo from the agent
    this.userEchoSkipCount++;
    this.sendButton.disabled = true;
    this.session.prompt(text, context).catch((error) => {
      if (this.session !== currentSession) return;
      this.userEchoSkipCount--;
      this.appendError(error.message || String(error));
      this.setAgentStatus("error");
      this.stopButton.disabled = true;
      this.updateInputControls();
    });
  }

  // Disposes the running session and resets all conversation/agent chrome to a
  // clean idle state. Shared by restart() and switchAgent(); does not start.
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
    this.updateAutoApproveButton();
    this.setFollowAgent(false);
    this.userEchoSkipCount = 0;
  }

  private restart(): void {
    this.resetSessionForRelaunch();
    this.setLifecycleStatus("Idle \u2014 type a message to start the agent.");
    this.updateInputControls();

    // Restart is user-initiated on a visible panel, so reconnect immediately
    // rather than waiting for the panel to be shown again. ensureStarted()
    // re-resolves the LATEST command from config (so live edits apply) and shows
    // the idle "pick an agent" state when nothing is launchable.
    this.ensureStarted();
  }

  // The only path that performs a process switch (distinct from Restart, which
  // relaunches the active agent).
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

    // No-op only when this exact target is already live (key on the running
    // snapshot, so a hand-edited config still applies when you pick it).
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
    this.setLifecycleStatus("Idle \u2014 starting agent\u2026");
    this.updateInputControls();
    this.activeTarget = target;
    this.renderAgentPicker();
    this.startTarget(target);
  }

  private setActiveAgentId(id: string): void {
    setActiveAgentId(id);
  }

  // Re-read config and refresh the picker. Purely a UI refresh: never starts,
  // stops, or switches a process, so it cannot loop with our own writes.
  refreshFromConfig(): void {
    this.agentsConfig = readAgentsConfig();
    this.renderAgentPicker();
    this.renderModelSelector();
    this.refreshTurnLimitInput();
  }

  // Called once after activate() seeds/migrates config. Picks up the migrated
  // shape and, if this panel already tried to start while config was still
  // unmigrated (and nothing launched), retries now that an agent may resolve.
  // Panels that were never shown keep their lazy start-on-visible behavior.
  refreshAfterMigration(): void {
    this.refreshFromConfig();
    const idle =
      this.startAttempted &&
      this.activeTarget == null &&
      this.session.sessionId == null &&
      !this.agentExited;
    if (idle) this.ensureStarted();
  }

  private pickerSelectedId(): string | undefined {
    return (
      this.activeTarget?.id ??
      this.selectedAgentId ??
      this.agentsConfig.activeAgentId
    );
  }

  private agentPickerLabel(): string {
    if (this.activeTarget) return this.activeTarget.name;
    const resolved = resolveAgent(this.agentsConfig, this.selectedAgentId);
    if (resolved.reason === "ok" && resolved.agent) return resolved.agent.name;
    if (resolved.reason === "no-agents") return "No agents";
    return "Select agent";
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
    const separator = document.createElement("div");
    separator.classList.add("pulsar-assistant-picker-separator");
    separator.setAttribute("role", "separator");
    this.agentMenu.appendChild(separator);
    const edit = document.createElement("button");
    edit.classList.add(
      "pulsar-assistant-picker-item",
      "pulsar-assistant-picker-edit",
    );
    edit.setAttribute("role", "menuitem");
    edit.textContent = "Edit configuration\u2026";
    edit.addEventListener("click", () => {
      this.closeAgentMenu();
      atom.commands.dispatch(this.element, "pulsar-assistant:edit-agents");
    });
    this.agentMenu.appendChild(edit);
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
    this.agentMenu.style.display = "";
    this.agentMenuOpen = true;
    this.agentPicker.setAttribute("aria-expanded", "true");
  }

  private closeAgentMenu(): void {
    this.agentMenu.style.display = "none";
    this.agentMenuOpen = false;
    this.agentPicker.setAttribute("aria-expanded", "false");
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
    this.sessionPlanState.clear();
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
    // Auto-open details so Restart stays reachable even if the agent died
    // before reporting any identity (e.g. a bad agent command).
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
    this.endAwaitingAuth();
    this.toolViews.clear();
    this.conversationTooltips.dispose();
    this.conversationTooltips = new CompositeDisposable();
    this.activePlanEntries = [];
    this.activePlanSessionId = null;
    this.renderPlanBar();
    this.preparingPrompt = false;
    this.clearContext();
    this.endStreamingBlocks();
    this.sessionApprovedKinds.clear();
    this.stickToBottom = true;
    this.generatingIndicator = null;
  }

  private startNewSession(): void {
    if (this.session.running || this.session.switching) return;
    this.closeSlashMenu();
    this.hideSlashHint();
    this.autoApprovePermissions = false;
    this.updateAutoApproveButton();
    this.setFollowAgent(false);
    const currentId = this.session.sessionId;
    if (currentId) this.stashConversation(currentId);
    this.session.newSession().catch((error) => {
      if (currentId) this.rollbackConversation(currentId);
      this.appendError(error instanceof Error ? error.message : String(error));
      this.updateInputControls();
      this.updateSessionControls();
    });
  }

  private setSessionsListVisible(visible: boolean): void {
    if (this.sessionsListVisible === visible) return;
    this.sessionsListVisible = visible;
    if (visible) {
      this.expandPanel(this.sessionsList);
      const active = this.sessionsList.querySelector<HTMLElement>(".pulsar-assistant-session-row.is-active");
      active?.scrollIntoView({ block: "nearest" });
    } else {
      this.collapsePanel(this.sessionsList);
    }
    this.sessionsToggle.setAttribute(
      "aria-expanded",
      String(this.sessionsListVisible),
    );
  }

  private switchToSession(id: string): void {
    if (this.session.running || this.session.switching) return;
    this.closeSlashMenu();
    this.hideSlashHint();
    this.autoApprovePermissions = false;
    this.updateAutoApproveButton();
    this.setFollowAgent(false);
    this.hideLoadingOverlay();
    const currentId = this.session.sessionId;
    const info = this.knownSessions.find((s) => s.sessionId === id);

    if (currentId) this.stashConversation(currentId);

    // If the agent already has this session loaded, re-activate it instead of
    // calling session/load again (agents reject loading an already-loaded
    // session). Restore the cached conversation DOM when we still have it.
    if (this.session.isSessionLoaded(id)) {
      this.resetConversationState();
      const cached = this.sessionConversationCache.get(id);
      if (cached !== undefined) this.swapInConversation(cached);
      this.restorePlanStateFor(id);
      this.session.activateCachedSession(id);
      return;
    }

    this.resetConversationState();
    // session/load replays history asynchronously; cover the blank pane with a
    // pulsing overlay until the "ready" event reveals the restored conversation.
    this.currentTokens = null;
    this.setLifecycleStatus("Loading session\u2026");
    this.setAgentStatus("connecting");
    this.showLoadingOverlay();
    this.updateSessionControls();
    this.session.loadSession(id, info?.cwd).catch((error) => {
      this.hideLoadingOverlay();
      if (currentId) this.rollbackConversation(currentId);
      this.setLifecycleStatus("");
      this.setAgentStatus("ready");
      this.appendError(error instanceof Error ? error.message : String(error));
      this.updateInputControls();
      this.updateSessionControls();
    });
  }

  // Cache the outgoing conversation DOM before switching away. The agent keeps
  // the session loaded, so returning to it must restore this exact node rather
  // than re-load it (agents reject loading an already-loaded session); reusing
  // the node also preserves canvas pixels and other live DOM state.
  private stashConversation(id: string): void {
    this.rememberPlanStateFor(id);
    this.sessionConversationCache.set(id, this.conversation);
    this.swapInFreshConversation();
  }

  // Restore a previously stashed conversation DOM after a failed new/load.
  private rollbackConversation(id: string): void {
    const prev = this.sessionConversationCache.get(id);
    if (prev) {
      this.swapInConversation(prev);
      this.restorePlanStateFor(id);
    }
  }

  private swapInFreshConversation(): void {
    const fresh = document.createElement("div");
    fresh.className = this.conversation.className;
    this.conversation.replaceWith(fresh);
    this.conversation = fresh;
    this.activePlanEntries = [];
    this.activePlanSessionId = null;
    this.renderPlanBar();
    this.stickToBottom = true;
    this.updateScrollToBottomButton();
    this.attachConversationScrollListener();
  }

  private showLoadingOverlay(): void {
    this.loadingOverlay.style.display = "";
  }

  private hideLoadingOverlay(): void {
    this.loadingOverlay.style.display = "none";
  }

  private setGeneratingState(
    state: "working" | "awaiting" | "stopping" | null,
  ): void {
    if (state === null) {
      if (this.generatingIndicator) {
        this.generatingIndicator.remove();
        this.generatingIndicator = null;
      }
      return;
    }
    if (!this.generatingIndicator) {
      this.generatingIndicator = document.createElement("div");
      this.generatingIndicator.classList.add("pulsar-assistant-generating");
    }
    const labels: Record<"working" | "awaiting" | "stopping", string> = {
      working: "Working\u2026",
      awaiting: "Awaiting confirmation\u2026",
      stopping: "Stopping\u2026",
    };
    this.generatingIndicator.textContent = labels[state];
    this.conversation.appendChild(this.generatingIndicator);
    this.scrollToBottom();
  }

  private swapInConversation(el: HTMLElement): void {
    this.conversation.replaceWith(el);
    this.conversation = el;
    this.stickToBottom = true;
    this.updateScrollToBottomButton();
    this.attachConversationScrollListener();
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case "status":
        this.setLifecycleStatus(event.text);
        this.setAgentStatus("connecting");
        break;
      case "initialized":
        this.agentExited = false;
        this.storedAgentInfo = event.info;
        this.storedCapabilities = event.capabilities;
        if (event.info && this.infoPanelOpen) this.renderInfoPanel();
        this.setLifecycleStatus("Connected");
        this.setAgentStatus("connecting");
        this.contextControl.style.display = this.session.supportsEmbeddedContext()
          ? ""
          : "none";
        this.updateInputControls();
        break;
      case "ready":
        this.lifecycleStatus = "";
        this.endAwaitingAuth();
        this.hideLoadingOverlay();
        this.renderPill();
        this.setAgentStatus(this.modelWarning ? "warning" : "ready");
        this.restoreLiveStateFor(this.session.sessionId);
        this.renderConfigSelectors();
        if (event.source === "new") {
          this.clearConversation();
        }
        if (event.source === "load") {
          this.endStreamingBlocks();
          this.snapshotCompletedPlan();
          this.stickToBottom = true;
          this.conversation.scrollTop = this.conversation.scrollHeight;
        }
        this.sessionsToggle.style.display = this.session.canListSessions()
          ? ""
          : "none";
        this.newSessionButton.style.display = "";
        this.updateSessionControls();
        this.updateInputControls();
        break;
      case "session-list":
        this.renderSessionsList(event.sessions);
        break;
      case "turn-start":
        this.closeSlashMenu();
        this.clearCompletedActivePlanEntries();
        this.setAgentStatus("working");
        this.stopButton.disabled = false;
        this.setGeneratingState("working");
        this.updateInputControls();
        this.updateSessionControls();
        break;
      case "turn-end":
        this.setAgentStatus(this.modelWarning ? "warning" : "ready");
        this.stopButton.disabled = true;
        this.setGeneratingState(null);
        this.updateInputControls();
        this.updateSessionControls();
        this.endStreamingBlocks();
        this.snapshotCompletedPlan();
        if (event.stopReason && event.stopReason !== "end_turn") {
          this.appendNote(`Turn stopped: ${event.stopReason}`);
        }
        this.session.refreshSessionList();
        break;
      case "update":
        this.handleUpdate(event.sessionId, event.update);
        break;
      case "permission":
        this.renderPermission(event.params, event.respond);
        break;
      case "auth-required":
        this.renderAuthPicker(event.methods, event.respond);
        break;
      case "permissions-cancelled":
        this.markPendingPermissionsCancelled();
        break;
      case "file-written":
        this.appendNote(`Wrote ${event.path}`);
        break;
      case "stderr":
        console.warn("[pulsar-assistant]", event.text);
        break;
      case "error":
        this.hideLoadingOverlay();
        this.setGeneratingState(null);
        this.appendError(event.message);
        this.setAgentStatus("error");
        this.stopButton.disabled = true;
        this.updateInputControls();
        break;
      case "exit": {
        if (this.agentExited) break;
        this.closeSlashMenu();
        this.hideSlashHint();
        this.hideLoadingOverlay();
        this.setGeneratingState(null);
        const detail = `exited${event.code != null ? ` (code ${event.code})` : ""}`;
        this.agentExited = true;
        this.currentTokens = null;
        this.renderLiveRow();
        this.renderConfigSelectors();
        this.finishAgentTeardown(`Agent ${detail}.`);
        break;
      }
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
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
        this.renderToolCall(update);
        break;
      case "plan":
        this.setActivePlan(update.entries || [], sessionId);
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
    // Skip duplicate user message echo from agent
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
    // ponytail: re-render the whole accumulated markdown, coalesced to one
    // render per frame so bursts of chunks don't reparse O(n) each.
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

  // Renders Markdown into el. Agent and user content frequently relays
  // untrusted data (file contents, tool/web output, prompt-injection payloads),
  // so the generated HTML is sanitized with DOMPurify to strip scripts and
  // inline event handlers.
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

  // --- Prompt context menu -------------------------------------------------
  // One "Attach to prompt" button in the actions row whose items stage prompt
  // content: Selection and File. The editor commands in main.ts feed the same
  // addSelectionContext / addActiveFileContext path. Items are shown only when
  // the agent advertises embedded context and greyed when not currently
  // applicable; staged chips are validated again at send.

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
  }

  // Stage the whole active file. Best-effort guards (untitled, in project) warn
  // and refuse here; the binding checks run again at send.
  async addActiveFileContext(
    editor: TextEditor | null | undefined,
  ): Promise<void> {
    if (!editor) {
      this.appendError("No active editor to attach.");
      return;
    }
    if (this.session.sessionId != null && !this.session.supportsEmbeddedContext()) {
      this.appendError(
        "The configured agent does not support embedded context.",
      );
      return;
    }
    const filePath = editor.getPath();
    if (!filePath) {
      this.appendError("Save the file before attaching it as context.");
      return;
    }
    const uri = fileUri(filePath);
    if (this.pendingContext.some((c) => c.uri === uri)) return;
    if (!(await this.session.isPathInProjectRoots(filePath))) {
      this.appendError(
        `"${path.basename(filePath)}" is outside the project and was not attached.`,
      );
      return;
    }
    const context: PendingContext = {
      id: this.nextContextId++,
      kind: "file",
      uri,
      label: path.basename(filePath),
      path: filePath,
      editor,
    };
    this.pendingContext.push(context);
    this.renderContextChip(context);
  }

  // Stage a snapshot of the last non-empty selection: its text plus the 1-based
  // inclusive line range from selectionLineRange (off-by-one details in util.ts).
  async addSelectionContext(
    editor: TextEditor | null | undefined,
  ): Promise<void> {
    if (!editor) {
      this.appendError("No active editor to attach.");
      return;
    }
    if (this.session.sessionId != null && !this.session.supportsEmbeddedContext()) {
      this.appendError(
        "The configured agent does not support embedded context.",
      );
      return;
    }
    const filePath = editor.getPath();
    if (!filePath) {
      this.appendError("Save the file before attaching a selection.");
      return;
    }
    const selection = this.lastNonEmptySelection(editor);
    if (!selection) {
      this.appendError("Select some text to attach a selection.");
      return;
    }
    const lineRange = selectionLineRange(selection.getBufferRange());
    // lastNonEmptySelection already excluded empty selections; this narrows the
    // nullable result for the URI and label below.
    if (!lineRange) return;
    const uri = fileUri(filePath, lineRange);
    if (this.pendingContext.some((c) => c.uri === uri)) return;
    if (!(await this.session.isPathInProjectRoots(filePath))) {
      this.appendError(
        `"${path.basename(filePath)}" is outside the project and was not attached.`,
      );
      return;
    }
    const name = path.basename(filePath);
    const label =
      lineRange.end > lineRange.start
        ? `${name}:${lineRange.start}-${lineRange.end}`
        : `${name}:${lineRange.start}`;
    const context: PendingContext = {
      id: this.nextContextId++,
      kind: "selection",
      uri,
      label,
      path: filePath,
      text: selection.getText(),
    };
    this.pendingContext.push(context);
    this.renderContextChip(context);
  }

  private lastNonEmptySelection(editor: TextEditor) {
    const last = editor.getLastSelection();
    if (last && !last.isEmpty()) return last;
    const selections = editor.getSelections();
    for (let i = selections.length - 1; i >= 0; i--) {
      if (!selections[i].isEmpty()) return selections[i];
    }
    return undefined;
  }

  private makeContextChip(kind: ContextKind, label: string): HTMLElement {
    const chip = document.createElement("span");
    chip.classList.add("pulsar-assistant-context-chip");
    const icon = document.createElement("span");
    icon.classList.add("icon", kind === "selection" ? "icon-code" : "icon-file");
    chip.appendChild(icon);
    const labelEl = document.createElement("span");
    labelEl.classList.add("pulsar-assistant-context-label");
    labelEl.textContent = label;
    chip.appendChild(labelEl);
    return chip;
  }

  private renderContextChip(context: PendingContext): void {
    this.contextStrip.style.display = "";
    const chip = this.makeContextChip(context.kind, context.label);
    const chipTip = atom.tooltips.add(chip, {
      title:
        context.kind === "selection"
          ? `Selection from ${context.path}`
          : context.path,
    });
    this.contextTooltips.add(chipTip);
    const remove = document.createElement("button");
    remove.classList.add("pulsar-assistant-context-remove");
    remove.textContent = "\u00d7";
    remove.setAttribute("aria-label", "Remove context");
    const tip = atom.tooltips.add(remove, { title: "Remove context" });
    this.contextTooltips.add(tip);
    remove.addEventListener("click", () => {
      this.contextTooltips.remove(chipTip);
      chipTip.dispose();
      this.contextTooltips.remove(tip);
      tip.dispose();
      const idx = this.pendingContext.findIndex((c) => c.id === context.id);
      if (idx >= 0) this.pendingContext.splice(idx, 1);
      chip.remove();
      if (this.contextStrip.children.length === 0)
        this.contextStrip.style.display = "none";
    });
    chip.appendChild(remove);
    this.contextStrip.appendChild(chip);
  }

  private clearContext(): void {
    this.contextTooltips.dispose();
    this.contextTooltips = new CompositeDisposable();
    this.contextStrip.innerHTML = "";
    this.contextStrip.style.display = "none";
    this.pendingContext = [];
  }

  // Resolve staged attachments to embedded-resource payloads at send time. The
  // active file is re-read (held editor → any open editor for the path → disk)
  // so unsaved edits are captured; the in-project check here is authoritative
  // (attach-time checks are best-effort). Consumes the chips and returns one
  // entry per attachment that survived, dropping + warning on the rest
  // (unsupported capability, unreadable, out-of-project).
  private async materializePendingContext(): Promise<MaterializedContext[]> {
    const pending = this.pendingContext;
    this.clearContext();
    if (pending.length === 0) return [];
    if (!this.session.supportsEmbeddedContext()) {
      this.appendError(
        "The configured agent does not support embedded context; attachments were not sent.",
      );
      return [];
    }
    const materialized: MaterializedContext[] = [];
    for (const context of pending) {
      if (!(await this.session.isPathInProjectRoots(context.path))) {
        this.appendError(
          `"${context.label}" is outside the project and was not sent.`,
        );
        continue;
      }
      const raw =
        context.kind === "file"
          ? await this.materializeFileContext(context)
          : (context.text ?? null);
      if (raw == null) {
        this.appendError(`"${context.label}" could not be read and was not sent.`);
        continue;
      }
      const text = raw.replace(/\r\n/g, "\n");
      materialized.push({
        uri: context.uri,
        text,
        kind: context.kind,
        label: context.label,
      });
    }
    return materialized;
  }

  private async materializeFileContext(
    context: PendingContext,
  ): Promise<string | null> {
    const held =
      context.editor && !context.editor.isDestroyed()
        ? context.editor
        : undefined;
    if (held) {
      const heldPath = held.getPath();
      if (heldPath && this.samePath(heldPath, context.path))
        return held.getText();
    }
    const open = atom.workspace.getTextEditors().find((item) => {
      const itemPath = item.getPath();
      return itemPath != null && this.samePath(itemPath, context.path);
    });
    if (open) return open.getText();
    try {
      return await fs.promises.readFile(context.path, "utf8");
    } catch {
      return null;
    }
  }

  private samePath(a: string, b: string): boolean {
    return path.relative(path.resolve(a), path.resolve(b)) === "";
  }

  private async openLocation(
    filePath: string,
    line?: number | null,
  ): Promise<void> {
    if (!(await this.isOpenableFile(filePath))) {
      atom.notifications.addWarning("Cannot open that location.", {
        detail: filePath,
      });
      return;
    }
    try {
      await atom.workspace.open(filePath, {
        initialLine: line ?? undefined,
        searchAllPanes: true,
      });
    } catch (error) {
      atom.notifications.addWarning("Could not open file.", {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async isOpenableFile(filePath: string): Promise<boolean> {
    if (!(await this.session.isPathInProjectRoots(filePath))) return false;
    try {
      return (await fs.promises.stat(filePath)).isFile();
    } catch {
      return false;
    }
  }
  private updateInputControls(): void {
    const busy =
      this.session.running ||
      this.session.switching ||
      this.preparingPrompt ||
      this.awaitingAuth;
    this.sendButton.disabled = busy;
    this.contextTrigger.disabled = busy;
    this.maxTurnRequestsInput.disabled = busy;
    this.updateConfigSelectorsDisabled();
    this.modelSelector?.updateDisabled();
  }

  private appendNote(text: string): void {
    this.appendMessage("note", text);
    this.scrollToBottom();
  }

  private appendError(text: string): void {
    const message = document.createElement("div");
    message.classList.add(
      "pulsar-assistant-message",
      "pulsar-assistant-message--error",
    );
    message.textContent = text;
    this.conversation.appendChild(message);
    this.scrollToBottom();
  }

  private renderToolCall(update: ToolUpdate): void {
    let tool = this.toolViews.get(update.toolCallId);
    if (!tool) {
      const element = document.createElement("div");
      element.classList.add("pulsar-assistant-tool");
      const heading = document.createElement("div");
      heading.classList.add("pulsar-assistant-tool-heading");
      const status = document.createElement("span");
      status.classList.add("pulsar-assistant-tool-status");
      const title = document.createElement("span");
      title.classList.add("pulsar-assistant-tool-title");
      heading.appendChild(status);
      heading.appendChild(title);
      const body = document.createElement("div");
      body.classList.add("pulsar-assistant-tool-body");
      const summary = document.createElement("div");
      summary.classList.add("pulsar-assistant-tool-summary");
      summary.style.display = "none";
      const toggle = document.createElement("button");
      toggle.classList.add("pulsar-assistant-tool-toggle");
      toggle.style.display = "none";
      toggle.setAttribute("aria-expanded", "false");
      element.appendChild(heading);
      element.appendChild(body);
      element.appendChild(summary);
      element.appendChild(toggle);
      tool = {
        element,
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
      const view = tool;
      toggle.addEventListener("click", () => {
        view.expanded = !view.expanded;
        this.applyToolExpansion(view);
      });
      const open = (): void => {
        if (!view.location || view.title.dataset.link !== "true") return;
        void this.openLocation(view.location.path, view.location.line);
      };
      title.addEventListener("click", open);
      title.addEventListener("keydown", (event) => {
        if (
          view.location &&
          view.title.dataset.link === "true" &&
          (event.key === "Enter" || event.key === " ")
        ) {
          event.preventDefault();
          open();
        }
      });
      this.toolViews.set(update.toolCallId, tool);
      this.conversation.appendChild(element);
      this.endStreamingBlocks();
    }

    if (update.title) tool.title.textContent = update.title;
    if (update.kind) tool.element.dataset.kind = update.kind;
    if (update.locations !== undefined) {
      tool.location =
        update.locations?.length === 1 ? update.locations[0] : null;
      void this.applyToolLocation(tool);
      if (this.followAgent && tool.location) {
        this.scheduleFollow(tool.location.path, tool.location.line);
      }
    }
    if (update.status) {
      tool.element.dataset.status = update.status;
      const statuses: Record<string, string> = {
        pending: "\u25cb",
        in_progress: "\u25d0",
        completed: "\u25cf",
        failed: "\u2715",
      };
      tool.status.textContent = statuses[update.status] || "";
    }
    if (Array.isArray(update.content)) {
      this.updateToolBody(tool, update.content);
    }
    this.scrollToBottom();
  }

  private async applyToolLocation(tool: ToolView): Promise<void> {
    const location = tool.location;
    const link = location != null && (await this.isOpenableFile(location.path));
    if (tool.location !== location || !tool.element.isConnected) return;
    if (link === (tool.title.dataset.link === "true")) return;
    tool.title.dataset.link = String(link);
    tool.heading.classList.toggle("pulsar-assistant-tool-heading--link", link);
    if (link) {
      tool.title.setAttribute("role", "button");
      tool.title.tabIndex = 0;
      tool.locationTooltip = atom.tooltips.add(tool.title, { title: "Go to File" });
      this.conversationTooltips.add(tool.locationTooltip);
    } else {
      tool.title.removeAttribute("role");
      tool.title.removeAttribute("tabindex");
      tool.locationTooltip?.dispose();
      tool.locationTooltip = null;
    }
  }

  private updateToolBody(
    tool: ToolView,
    content: acp.ToolCallContent[],
  ): void {
    tool.body.textContent = "";
    for (const item of content) {
      if (item.type === "terminal") continue;
      tool.body.appendChild(this.renderToolContent(item));
    }

    const lines = this.toolBodyLineCount(tool.body);
    const diff = content.some((item) => item.type === "diff");
    tool.diff = diff;
    tool.collapsible = lines > (diff ? 20 : 3);
    tool.summary.textContent = this.toolBodySummary(tool, lines);
    this.applyToolOverflow(tool);
  }

  private toolBodyLineCount(body: HTMLElement): number {
    const text = body.innerText ?? body.textContent ?? "";
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0).length;
  }

  private toolBodySummary(tool: ToolView, lines: number): string {
    if (tool.diff) return `${lines} diff lines`;
    if (tool.element.dataset.kind === "search") return `${lines} results`;
    return `${lines} output lines`;
  }

  private applyToolExpansion(tool: ToolView): void {
    this.applyToolOverflow(tool);
    this.scrollToBottom();
  }

  private applyToolOverflow(tool: ToolView): void {
    tool.body.classList.toggle(
      "pulsar-assistant-tool-body--expanded",
      tool.expanded,
    );
    tool.body.classList.toggle(
      "pulsar-assistant-tool-body--collapsed",
      tool.collapsible && !tool.expanded,
    );
    tool.body.classList.toggle(
      "pulsar-assistant-tool-body--collapsed-text",
      tool.collapsible && !tool.expanded && !tool.diff,
    );
    tool.body.classList.toggle(
      "pulsar-assistant-tool-body--collapsed-diff",
      tool.collapsible && !tool.expanded && tool.diff,
    );
    tool.summary.style.display =
      tool.collapsible && !tool.expanded ? "" : "none";
    tool.toggle.style.display = tool.collapsible ? "" : "none";
    tool.toggle.textContent = tool.expanded ? "Show less" : "Show more";
    tool.toggle.setAttribute("aria-expanded", String(tool.expanded));
  }

  private renderToolContent(item: acp.ToolCallContent): HTMLElement {
    const node = document.createElement("div");
    if (item.type === "diff") {
      node.classList.add("pulsar-assistant-diff");
      this.renderDiff(node, item);
    } else if (item.type === "content") {
      node.textContent = this.contentToText(item.content);
    }
    return node;
  }

  private renderDiff(node: HTMLElement, diff: acp.Diff): void {
    this.appendDiffLine(node, "path", `--- ${diff.path}`);
    this.appendDiffLine(node, "path", `+++ ${diff.path}`);

    const oldLines = this.contentLines(diff.oldText ?? "");
    const newLines = this.contentLines(diff.newText);
    let prefixLength = 0;
    while (
      prefixLength < oldLines.length &&
      prefixLength < newLines.length &&
      oldLines[prefixLength] === newLines[prefixLength]
    ) {
      prefixLength++;
    }

    let oldSuffixStart = oldLines.length;
    let newSuffixStart = newLines.length;
    while (
      oldSuffixStart > prefixLength &&
      newSuffixStart > prefixLength &&
      oldLines[oldSuffixStart - 1] === newLines[newSuffixStart - 1]
    ) {
      oldSuffixStart--;
      newSuffixStart--;
    }

    const DIFF_CONTEXT = 3;
    const prefixStart = Math.max(0, prefixLength - DIFF_CONTEXT);
    if (prefixStart > 0) {
      this.appendDiffLine(node, "context", " \u2026");
    }
    for (const line of oldLines.slice(prefixStart, prefixLength)) {
      this.appendDiffLine(node, "context", ` ${line}`);
    }
    for (const line of oldLines.slice(prefixLength, oldSuffixStart)) {
      this.appendDiffLine(node, "removed", `-${line}`);
    }
    for (const line of newLines.slice(prefixLength, newSuffixStart)) {
      this.appendDiffLine(node, "added", `+${line}`);
    }
    const suffixEnd = Math.min(oldLines.length, oldSuffixStart + DIFF_CONTEXT);
    for (const line of oldLines.slice(oldSuffixStart, suffixEnd)) {
      this.appendDiffLine(node, "context", ` ${line}`);
    }
    if (suffixEnd < oldLines.length) {
      this.appendDiffLine(node, "context", " \u2026");
    }
  }

  private contentLines(text: string): string[] {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  private appendDiffLine(
    node: HTMLElement,
    kind: "path" | "context" | "added" | "removed",
    text: string,
  ): void {
    const line = document.createElement("div");
    line.classList.add(
      "pulsar-assistant-diff-line",
      `pulsar-assistant-diff-line--${kind}`,
    );
    line.textContent = text;
    node.appendChild(line);
  }

  private clonePlanEntries(entries: acp.PlanEntry[]): acp.PlanEntry[] {
    return entries.map((entry) => ({ ...entry }));
  }

  private rememberPlanStateFor(sessionId: string): void {
    if (this.activePlanEntries.length > 0) {
      this.sessionPlanState.set(
        sessionId,
        this.clonePlanEntries(this.activePlanEntries),
      );
    } else {
      this.sessionPlanState.delete(sessionId);
    }
  }

  private restorePlanStateFor(sessionId: string | null): void {
    this.activePlanEntries = sessionId
      ? this.clonePlanEntries(this.sessionPlanState.get(sessionId) ?? [])
      : [];
    this.activePlanSessionId =
      this.activePlanEntries.length > 0 ? sessionId : null;
    this.renderPlanBar();
  }

  private setActivePlan(
    entries: acp.PlanEntry[],
    sessionId: string | null,
  ): void {
    this.activePlanEntries = this.clonePlanEntries(entries);
    this.activePlanSessionId =
      this.activePlanEntries.length > 0 ? sessionId : null;
    if (sessionId) {
      if (this.activePlanEntries.length > 0) {
        this.sessionPlanState.set(
          sessionId,
          this.clonePlanEntries(this.activePlanEntries),
        );
      } else {
        this.sessionPlanState.delete(sessionId);
      }
    }
    this.renderPlanBar();
  }

  private clearActivePlan(sessionId: string | null): void {
    this.activePlanEntries = [];
    this.activePlanSessionId = null;
    if (sessionId) this.sessionPlanState.delete(sessionId);
    this.renderPlanBar();
  }

  // The live plan is a pinned bar above the composer (matching Zed and VS
  // Code) so it stays glanceable while the conversation scrolls; only the
  // completed plan is snapshotted into the transcript.
  private renderPlanBar(): void {
    const entries = this.activePlanEntries;
    this.planBar.innerHTML = "";
    if (entries.length === 0) {
      this.planBar.style.display = "none";
      return;
    }
    this.planBar.style.display = "";

    const total = entries.length;
    const completed = entries.filter((e) => e.status === "completed").length;
    const inProgress = entries.find((e) => e.status === "in_progress");

    const header = document.createElement("div");
    header.classList.add("pulsar-assistant-plan-bar-header");

    const twisty = document.createElement("span");
    twisty.classList.add(
      "pulsar-assistant-plan-bar-twisty",
      "icon",
      this.planExpanded ? "icon-chevron-down" : "icon-chevron-right",
    );

    const title = document.createElement("span");
    title.classList.add("pulsar-assistant-plan-bar-title");
    title.textContent =
      !this.planExpanded && inProgress
        ? `Current: ${inProgress.content}`
        : "Plan";

    const count = document.createElement("span");
    count.classList.add("pulsar-assistant-plan-bar-count");
    count.textContent =
      completed === total
        ? "All done"
        : completed === 0
          ? `${total} tasks`
          : `${completed}/${total}`;

    const dismiss = document.createElement("button");
    dismiss.classList.add("pulsar-assistant-plan-bar-dismiss", "icon", "icon-x");
    dismiss.setAttribute("aria-label", "Clear plan");
    dismiss.addEventListener("click", (event) => {
      event.stopPropagation();
      this.clearActivePlan(this.activePlanSessionId);
    });

    header.appendChild(twisty);
    header.appendChild(title);
    header.appendChild(count);
    header.appendChild(dismiss);
    header.addEventListener("click", () => {
      this.planExpanded = !this.planExpanded;
      this.renderPlanBar();
    });
    this.planBar.appendChild(header);

    if (this.planExpanded) {
      const body = document.createElement("div");
      body.classList.add("pulsar-assistant-plan-bar-body");
      this.appendPlanEntries(body, entries);
      this.planBar.appendChild(body);
    }
  }

  private appendPlanEntries(
    container: HTMLElement,
    entries: acp.PlanEntry[],
  ): void {
    const marks: Record<string, string> = {
      pending: "\u25cb",
      in_progress: "\u25d0",
      completed: "\u2713",
    };
    for (const entry of entries) {
      const row = document.createElement("div");
      row.classList.add("pulsar-assistant-plan-entry");
      row.dataset.status = entry.status;
      row.textContent = `${marks[entry.status] || "\u25cb"} ${entry.content}`;
      container.appendChild(row);
    }
  }

  private snapshotCompletedPlan(): void {
    if (!completedPlanEntries(this.activePlanEntries)) {
      return;
    }

    const card = document.createElement("div");
    card.classList.add(
      "pulsar-assistant-plan",
      "pulsar-assistant-plan--completed",
    );
    const heading = document.createElement("div");
    heading.classList.add("pulsar-assistant-plan-heading");
    heading.textContent = "Completed Plan";
    card.appendChild(heading);
    this.appendPlanEntries(card, this.activePlanEntries);
    this.conversation.appendChild(card);

    const sessionId = this.activePlanSessionId;
    this.activePlanEntries = [];
    this.activePlanSessionId = null;
    if (sessionId) this.sessionPlanState.delete(sessionId);
    this.renderPlanBar();
    this.scrollToBottom();
  }

  private clearCompletedActivePlanEntries(): void {
    if (this.activePlanEntries.length === 0) return;
    const entries = nextTurnActivePlanEntries(this.activePlanEntries);
    if (entries.length === this.activePlanEntries.length) return;
    this.setActivePlan(entries, this.session.sessionId);
  }

  private markPendingPermissionsCancelled(): void {
    const blocks = Array.from(
      this.conversation.querySelectorAll(
        ".pulsar-assistant-permission:not([data-resolved])",
      ),
    ) as HTMLElement[];
    for (const block of blocks) {
      block.dataset.resolved = "cancelled";
      const question = block.querySelector(
        ".pulsar-assistant-permission-question",
      ) as HTMLElement | null;
      if (question) {
        this.setPermissionQuestionText(
          question,
          `Cancelled \u2014 ${block.dataset.toolTitle || "an action"}`,
        );
      }
      const buttons = Array.from(
        block.querySelectorAll(".pulsar-assistant-permission-options button"),
      ) as HTMLButtonElement[];
      for (const button of buttons) {
        button.disabled = true;
      }
    }
  }

  private setPermissionQuestionText(question: HTMLElement, text: string): void {
    const textNode = Array.from(question.childNodes).find(
      (node) => node.nodeType === TEXT_NODE_TYPE,
    );
    if (textNode) textNode.textContent = ` ${text}`;
    else question.appendChild(document.createTextNode(` ${text}`));
  }

  private renderPermission(
    params: acp.RequestPermissionRequest,
    respond: (outcome: acp.RequestPermissionResponse) => void,
  ): void {
    const toolCall = params.toolCall;
    const toolTitle = toolCall?.title || "an action";
    const kind = toolCall?.kind;

    if (kind && this.sessionApprovedKinds.has(kind)) {
      const option = params.options?.find((o) => o.kind === "allow_once");
      if (option) {
        respond({ outcome: { outcome: "selected", optionId: option.optionId } });
        if (this.session.running) {
          this.setGeneratingState("working");
          this.setAgentStatus("working");
        }
        return;
      }
    }

    if (this.autoApprovePermissions) {
      const option =
        params.options?.find((o) => o.kind === "allow_once");
      if (option) {
        respond({ outcome: { outcome: "selected", optionId: option.optionId } });
        if (this.session.running) {
          this.setGeneratingState("working");
          this.setAgentStatus("working");
        }
        return;
      }
    }

    this.setGeneratingState("awaiting");
    this.setAgentStatus("awaiting");

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
      execute: "gear",
      think: "light-bulb",
      fetch: "cloud-download",
      switch_mode: "git-compare",
      other: "tools",
    };
    const iconName = kind ? (kindIcons[kind] ?? "tools") : "tools";

    // Helper: build icon span + label text
    const makeLabel = (label: string): DocumentFragment => {
      const frag = document.createDocumentFragment();
      const iconEl = document.createElement("span");
      iconEl.classList.add("icon", `icon-${iconName}`);
      frag.appendChild(iconEl);
      frag.appendChild(document.createTextNode(` ${label}`));
      return frag;
    };

    // Header: kind icon + title
    const question = document.createElement("div");
    question.classList.add("pulsar-assistant-permission-question");
    question.appendChild(makeLabel(`Allow: ${toolTitle}?`));
    block.appendChild(question);

    // Affected locations
    if (toolCall?.locations && toolCall.locations.length > 0) {
      const locations = document.createElement("div");
      locations.classList.add("pulsar-assistant-permission-locations");
      for (const loc of toolCall.locations) {
        const entry = document.createElement("button");
        entry.type = "button";
        entry.classList.add("pulsar-assistant-permission-location");
        entry.textContent = loc.line != null ? `${loc.path}:${loc.line + 1}` : loc.path;
        this.conversationTooltips.add(
          atom.tooltips.add(entry, { title: "Go to File" }),
        );
        entry.addEventListener("click", () => {
          void this.openLocation(loc.path, loc.line);
        });
        locations.appendChild(entry);
      }
      block.appendChild(locations);
    }

    // Tool content (diffs, text)
    if (toolCall?.content && toolCall.content.length > 0) {
      const contentEl = document.createElement("div");
      contentEl.classList.add("pulsar-assistant-permission-content");
      for (const item of toolCall.content) {
        if (item.type === "terminal") continue;
        contentEl.appendChild(this.renderToolContent(item));
      }
      if (contentEl.hasChildNodes()) block.appendChild(contentEl);
    }

    // Prominent command/URL extracted from rawInput
    if (toolCall?.rawInput != null && kind != null) {
      const raw = toolCall.rawInput as Record<string, unknown>;
      const commands: string[] = [];
      if (kind === "execute") {
        if (typeof raw["command"] === "string") {
          commands.push(raw["command"]);
        } else if (Array.isArray(raw["commands"])) {
          for (const c of raw["commands"])
            if (typeof c === "string") commands.push(c);
        }
      } else if (kind === "fetch") {
        if (typeof raw["url"] === "string") commands.push(raw["url"]);
      }
      if (commands.length > 0) {
        const cmdEl = document.createElement("div");
        cmdEl.classList.add("pulsar-assistant-permission-commands");
        for (const cmd of commands) {
          const pre = document.createElement("pre");
          pre.textContent = cmd;
          cmdEl.appendChild(pre);
        }
        block.appendChild(cmdEl);
      }
    }

    // Collapsible raw input
    if (toolCall?.rawInput != null) {
      const details = document.createElement("details");
      details.classList.add("pulsar-assistant-permission-raw");
      const summary = document.createElement("summary");
      summary.textContent = "Raw input";
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(toolCall.rawInput, null, 2);
      details.appendChild(summary);
      details.appendChild(pre);
      block.appendChild(details);
    }

    // Option buttons with kind-aware styling
    const buttons = document.createElement("div");
    buttons.classList.add("pulsar-assistant-permission-options");

    const settle = (optionId: string, label: string): void => {
      respond({
        outcome: { outcome: "selected", optionId },
      });
      for (const child of Array.from(buttons.children))
        (child as HTMLButtonElement).disabled = true;
      block.dataset.resolved = optionId;
      question.replaceChildren(makeLabel(`${label} \u2014 ${toolTitle}`));
      if (this.session.running) {
        this.setGeneratingState("working");
        this.setAgentStatus("working");
      }
    };

    for (const option of params.options || []) {
      const button = this.makeButton(option.name, () => {
        settle(option.optionId, option.name);
      });
      button.dataset.optionKind = option.kind;
      if (option.kind === "reject_once" || option.kind === "reject_always")
        button.classList.add("pulsar-assistant-reject");
      if (option.kind === "allow_always")
        button.classList.add("pulsar-assistant-allow-always");
      buttons.appendChild(button);
    }

    const allowOnce = params.options?.find((o) => o.kind === "allow_once");
    if (allowOnce && kind) {
      const sessionAllow = this.makeButton("Allow for this session", () => {
        this.sessionApprovedKinds.add(kind);
        settle(allowOnce.optionId, "Allow for this session");
      });
      sessionAllow.dataset.optionKind = "allow_once";
      buttons.appendChild(sessionAllow);
    }

    block.appendChild(buttons);

    this.conversation.appendChild(block);
    this.scrollToBottom();
  }

  private renderAuthPicker(
    methods: acp.AuthMethodAgent[],
    respond: (methodId: acp.AuthMethodId | null) => void,
  ): void {
    this.removeAuthCard();
    this.awaitingAuth = true;
    this.setLifecycleStatus(
      "Authentication required \u2014 choose how to sign in.",
    );
    this.setAgentStatus("connecting");

    const block = document.createElement("div");
    block.classList.add("pulsar-assistant-auth");

    const question = document.createElement("div");
    question.classList.add("pulsar-assistant-auth-question");
    const icon = document.createElement("span");
    icon.classList.add("icon", "icon-key");
    question.appendChild(icon);
    question.appendChild(document.createTextNode(" Choose how to sign in:"));
    block.appendChild(question);

    const options = document.createElement("div");
    options.classList.add("pulsar-assistant-auth-options");

    const choose = (methodId: acp.AuthMethodId | null): void => {
      respond(methodId);
      this.removeAuthCard();
    };

    for (const method of methods) {
      const button = this.makeButton(method.name, () => choose(method.id));
      if (method.description) {
        this.authTooltips.add(
          atom.tooltips.add(button, { title: method.description, html: false }),
        );
      }
      options.appendChild(button);
    }

    const cancel = this.makeButton("Cancel", () => choose(null));
    cancel.classList.add("pulsar-assistant-reject");
    options.appendChild(cancel);

    block.appendChild(options);
    this.conversation.appendChild(block);
    this.authCard = block;
    this.updateInputControls();
    this.updateSessionControls();
    this.scrollToBottom();
    options.querySelector<HTMLButtonElement>("button")?.focus();
  }

  private removeAuthCard(): void {
    this.authTooltips.dispose();
    this.authTooltips = new CompositeDisposable();
    if (this.authCard) {
      this.authCard.remove();
      this.authCard = null;
    }
  }

  private endAwaitingAuth(): void {
    this.removeAuthCard();
    if (!this.awaitingAuth) return;
    this.awaitingAuth = false;
    this.updateInputControls();
    this.updateSessionControls();
  }

  private renderSessionsList(sessions: acp.SessionInfo[]): void {
    this.knownSessions = sessions;
    this.sessionTooltips.dispose();
    this.sessionTooltips = new CompositeDisposable();
    // Remove existing session rows
    const rows = this.sessionsList.querySelectorAll(".pulsar-assistant-session-row");
    rows.forEach((r) => r.remove());

    for (const info of sessions) {
      const row = document.createElement("div");
      row.classList.add("pulsar-assistant-session-row");
      row.dataset.sessionId = info.sessionId;
      if (info.sessionId === this.session.sessionId) {
        row.classList.add("is-active");
      }

      const entry = document.createElement("button");
      entry.classList.add("pulsar-assistant-session-entry");
      entry.disabled =
        this.session.running ||
        this.session.switching ||
        !this.session.canLoadSession() ||
        info.sessionId === this.session.sessionId;

      const titleEl = document.createElement("span");
      titleEl.classList.add("pulsar-assistant-session-title");
      titleEl.textContent = info.title || info.sessionId;
      this.sessionTooltips.add(
        atom.tooltips.add(titleEl, {
          title: info.title || info.sessionId,
          html: false,
          class: "pulsar-assistant-tooltip",
        }),
      );

      const timeEl = document.createElement("span");
      timeEl.classList.add("pulsar-assistant-session-time");
      timeEl.textContent = info.updatedAt ? this.relativeTime(info.updatedAt) : "";

      entry.appendChild(titleEl);
      entry.appendChild(timeEl);
      entry.addEventListener("click", () => {
        if (info.sessionId !== this.session.sessionId) {
          this.setSessionsListVisible(false);
          this.switchToSession(info.sessionId);
        }
      });

      const canDelete = this.session.canDeleteSession();
      const del = document.createElement("button");
      del.classList.add("pulsar-assistant-session-delete", "icon", "icon-trashcan");
      del.setAttribute("aria-label", "Delete session");
      del.style.display = canDelete ? "" : "none";
      this.sessionTooltips.add(
        atom.tooltips.add(del, { title: "Delete session" }),
      );
      del.disabled = this.session.running || this.session.switching || !canDelete;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteSession(info.sessionId);
      });

      row.appendChild(entry);
      row.appendChild(del);
      this.sessionsList.appendChild(row);
    }
  }

  private deleteSession(id: string): void {
    if (this.session.running || this.session.switching) return;
    const info = this.knownSessions.find((s) => s.sessionId === id);
    const label = info?.title || id;
    atom.confirm(
      {
        type: "warning",
        message: "Delete this session?",
        detail: `"${label}" will be permanently removed. This cannot be undone.`,
        buttons: ["Delete", "Cancel"],
        defaultId: 1,
      },
      (response) => {
        if (response === 0) this.performDeleteSession(id, info?.cwd);
      },
    );
  }

  private performDeleteSession(id: string, cwd?: string): void {
    if (this.session.running || this.session.switching) return;
    const result = this.session.deleteSession(id, cwd);
    this.updateInputControls();
    this.updateSessionControls();
    result.then(({ deletedActive }) => {
      this.sessionConversationCache.delete(id);
      this.sessionLiveState.delete(id);
      this.sessionPlanState.delete(id);
      if (deletedActive) {
        this.clearConversation();
        this.startNewSession();
      } else {
        this.updateInputControls();
        this.updateSessionControls();
      }
    }).catch((error) => {
      this.appendError(error instanceof Error ? error.message : String(error));
      this.updateInputControls();
      this.updateSessionControls();
    });
  }

  private applySessionInfoUpdate(
    sessionId: acp.SessionId,
    update: acp.SessionInfoUpdate,
  ): void {
    const index = this.knownSessions.findIndex(
      (session) => session.sessionId === sessionId,
    );
    if (index === -1) return;

    const nextSessions = this.knownSessions.slice();
    const nextInfo = { ...nextSessions[index] };
    if (update.title !== undefined) nextInfo.title = update.title;
    if (update.updatedAt !== undefined) nextInfo.updatedAt = update.updatedAt;
    nextSessions[index] = nextInfo;
    this.renderSessionsList(nextSessions);
    this.updateSessionControls();
  }

  private updateSessionControls(): void {
    const busy =
      this.session.running || this.session.switching || this.awaitingAuth;
    const canDelete = this.session.canDeleteSession();
    this.newSessionButton.disabled = busy;
    for (const row of Array.from(
      this.sessionsList.querySelectorAll<HTMLElement>(".pulsar-assistant-session-row"),
    )) {
      const id = row.dataset.sessionId;
      const entry = row.querySelector<HTMLButtonElement>(".pulsar-assistant-session-entry");
      const del = row.querySelector<HTMLButtonElement>(".pulsar-assistant-session-delete");
      if (entry) {
        const canLoad = this.session.canLoadSession() && id !== this.session.sessionId;
        entry.disabled = busy || !canLoad;
      }
      if (del) del.disabled = busy || !canDelete;
    }
  }

  private relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  private setLifecycleStatus(text: string): void {
    this.lifecycleStatus = text;
    this.renderPill();
  }

  private setAgentStatus(status: AgentStatus): void {
    this.reporter?.report(this, status, this.currentAgentName());
  }

  private currentAgentName(): string | null {
    const info = this.storedAgentInfo;
    return info ? info.title || info.name : null;
  }

  private currentModelId(): string | null {
    if (this.activeTarget?.kind !== "openai") return null;
    return this.selectedModelId ?? this.activeTarget.model;
  }

  private currentModelDescription(): string | null {
    const id = this.currentModelId();
    if (!id || !this.modelList) return null;
    return this.modelList.find((model) => model.id === id)?.description ?? null;
  }

  private renderLiveRow(): void {
    let text = this.currentTokens ?? "";
    let isLifecycle = false;
    if (!text && (!this.storedAgentInfo || this.agentExited)) {
      text = this.lifecycleStatus || (this.agentExited ? "Agent exited" : "Starting\u2026");
      isLifecycle = true;
    }
    this.liveStatusEl.textContent = text;
    this.liveStatusEl.style.display = text ? "" : "none";
    this.liveStatusEl.classList.toggle(
      "pulsar-assistant-token-usage--lifecycle",
      isLifecycle,
    );
    const hasDetails = this.infoButton.style.display !== "none";
    this.runtimeStatusEl.style.display = hasDetails || text ? "" : "none";
  }

  // Token usage is per-session; remember it so switching back to a session
  // restores its live row instead of showing a blank one.
  private rememberLiveState(sessionId: string, tokens: string | null): void {
    this.sessionLiveState.set(sessionId, { tokens });
  }

  private restoreLiveStateFor(sessionId: string | null): void {
    const state = sessionId ? this.sessionLiveState.get(sessionId) : undefined;
    this.currentTokens = state?.tokens ?? null;
    this.renderLiveRow();
  }

  private attachConversationScrollListener(): void {
    // Cached conversations are re-swapped on session switch; bind each element
    // only once so listeners don't accumulate.
    if (this.scrollBoundConversations.has(this.conversation)) return;
    this.scrollBoundConversations.add(this.conversation);
    // Capture the element so each conversation's handlers reference their own
    // node rather than whichever conversation is currently active.
    const conversation = this.conversation;
    const markUser = () => {
      this.lastUserScrollAt = Date.now();
    };
    conversation.addEventListener("wheel", markUser, { passive: true });
    conversation.addEventListener("keydown", markUser);
    conversation.addEventListener("pointerdown", () => {
      this.pointerDownInConversation = true;
    });
    conversation.addEventListener("pointerup", () => {
      this.pointerDownInConversation = false;
    });

    // Only a user-driven scroll (wheel, keyboard, touch, or scrollbar drag)
    // unsticks autoscroll. Layout-induced scroll events must not flip the flag,
    // or the view would freeze partway up. Reaching the bottom always re-sticks.
    conversation.addEventListener("scroll", () => {
      const distance =
        conversation.scrollHeight -
        conversation.scrollTop -
        conversation.clientHeight;
      if (distance <= 50) {
        this.stickToBottom = true;
      } else if (
        this.pointerDownInConversation ||
        Date.now() - this.lastUserScrollAt < 200
      ) {
        this.stickToBottom = false;
      }
      this.updateScrollToBottomButton();
    });
  }

  private updateScrollToBottomButton(): void {
    this.scrollToBottomButton.style.display = this.stickToBottom ? "none" : "";
  }

  private scrollToBottom(): void {
    if (
      this.generatingIndicator &&
      this.conversation.lastElementChild !== this.generatingIndicator
    ) {
      this.conversation.appendChild(this.generatingIndicator);
    }
    if (!this.stickToBottom) return;
    this.conversation.scrollTop = this.conversation.scrollHeight;
  }

  getTitle(): string {
    return `Pulsar Assistant | ${projectFolderName(this.projectRoot)}`;
  }

  getURI(): string {
    return uriForProject(this.projectRoot);
  }

  getElement(): HTMLElement {
    return this.element;
  }

  getIconName(): string {
    return "hubot";
  }

  getDefaultLocation(): DockLocation {
    return "right";
  }

  getAllowedLocations(): DockLocation[] {
    return ["right", "left", "bottom"];
  }

  getPreferredWidth(): number {
    return 400;
  }

  serialize(): {
    deserializer: string;
    projectRoot: string;
    selectedAgentId?: string;
    selectedModelId?: string;
  } {
    return {
      deserializer: "PulsarAssistantView",
      projectRoot: this.projectRoot,
      selectedAgentId: this.selectedAgentId ?? this.activeTarget?.id,
      selectedModelId: this.selectedModelId ?? undefined,
    };
  }

  destroy(): void {
    this.disconnectStartObserver();
    this.clearFollowEffects();
    if (this.streamRenderHandle !== null) {
      cancelAnimationFrame(this.streamRenderHandle);
    }
    this.modelFetchController?.abort();
    this.modelFetchController = null;
    this.modelSelector?.dispose();
    this.modelSelector = null;
    this.reporter?.clear(this);
    this.sessionTooltips.dispose();
    this.conversationTooltips.dispose();
    this.authTooltips.dispose();
    this.contextTooltips.dispose();
    for (const selector of this.configSelectors) selector.dispose();
    this.configSelectors = [];
    this.subscriptions.dispose();
    this.session.dispose();
    if (this.element) this.element.remove();
  }
}
