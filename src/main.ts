import { CommandEvent, CompositeDisposable, Disposable, TextEditor } from "atom";
import type { StatusBar } from "atom/status-bar";
import { PulsarAssistantView } from "./view/agent-view";
import { migrateAgentsConfigStore } from "./view/config-store";
import { StatusIndicator } from "./view/status-indicator";
import {
  isOpenProjectRoot,
  parseAgentUri,
  projectRootForFile,
  resolveCurrentProjectRoot,
  sameProjectRoot,
  uriForProject,
} from "./workspace";

let subscriptions: CompositeDisposable;
let indicator: StatusIndicator | null = null;
const views = new Set<PulsarAssistantView>();

function getIndicator(): StatusIndicator {
  return (indicator ??= new StatusIndicator(() => {
    void openForCurrentProject({ focus: true });
  }));
}

export type SerializedViewState = {
  deserializer?: string;
  projectRoot?: string;
  selectedAgentId?: string;
};

function createView(
  projectRoot: string,
  selectedAgentId?: string,
): PulsarAssistantView {
  for (const existing of views) {
    if (sameProjectRoot(existing.projectRoot, projectRoot)) return existing;
  }
  const view = new PulsarAssistantView(projectRoot, getIndicator(), {
    selectedAgentId,
  });
  const destroy = view.destroy.bind(view);
  view.destroy = () => {
    views.delete(view);
    destroy();
  };
  views.add(view);
  return view;
}

function pathFromCommandEvent(event?: CommandEvent): string | undefined {
  const candidates: Array<EventTarget | null | undefined> = [
    event?.target,
    event?.currentTarget,
  ];
  for (const candidate of candidates) {
    const start =
      candidate instanceof Element
        ? candidate
        : candidate instanceof Node
          ? candidate.parentElement
          : null;
    const node = start?.closest("[data-path]");
    const filePath = node?.getAttribute("data-path");
    if (filePath) return filePath;
  }
  return undefined;
}

function notifyNoProject(): void {
  atom.notifications.addWarning("Pulsar Assistant", {
    description:
      "Open a file, or right-click a file in the tree view, that belongs to a project folder.",
  });
}

async function openProjectPanel(
  projectRoot: string,
  options: { searchAllPanes?: boolean; activate?: boolean } = {},
): Promise<PulsarAssistantView | null> {
  const item = await atom.workspace.open(uriForProject(projectRoot), {
    searchAllPanes: options.searchAllPanes !== false,
    activatePane: options.activate !== false,
    activateItem: options.activate !== false,
  });
  return item instanceof PulsarAssistantView ? item : null;
}

async function openForCurrentProject(opts: {
  toggle?: boolean;
  focus?: boolean;
  filePath?: string | null;
}): Promise<void> {
  const filePath =
    opts.filePath ||
    atom.workspace.getCenter().getActiveTextEditor()?.getPath();
  const root = resolveCurrentProjectRoot(filePath);
  if (!root) {
    notifyNoProject();
    return;
  }
  const uri = uriForProject(root);
  if (opts.toggle) {
    await atom.workspace.toggle(uri);
    return;
  }
  await openProjectPanel(root);
}

async function addEditorContext(
  event: CommandEvent,
  kind: "file" | "selection",
): Promise<void> {
  const element = event.currentTarget as unknown as {
    getModel?: () => TextEditor | undefined;
  };
  const editor =
    element.getModel?.() ?? atom.workspace.getCenter().getActiveTextEditor();
  if (!editor) return;
  const root = projectRootForFile(editor.getPath());
  if (!root) {
    atom.notifications.addWarning("Pulsar Assistant", {
      description: "That file is not inside an open project folder.",
    });
    return;
  }
  const item = await openProjectPanel(root);
  if (!item) return;
  if (kind === "file") await item.addActiveFileContext(editor);
  else await item.addSelectionContext(editor);
}

function editorHasSelection(): boolean {
  const editor = atom.workspace.getCenter().getActiveTextEditor();
  return !!editor && editor.getSelections().some((s) => !s.isEmpty());
}

export function activate(): void {
  migrateAgentsConfigStore();
  for (const view of views) view.refreshAfterMigration();

  subscriptions = new CompositeDisposable();
  subscriptions.add(
    atom.workspace.addOpener((uri: string) => {
      const root = parseAgentUri(uri);
      if (!root || !isOpenProjectRoot(root)) return;
      return createView(root);
    }),
    atom.project.onDidChangePaths(() => {
      for (const view of Array.from(views)) {
        if (!isOpenProjectRoot(view.projectRoot)) view.destroy();
      }
    }),
    atom.commands.add("atom-workspace", {
      "pulsar-assistant:open-for-project": {
        displayName: "Pulsar Assistant: Open for this Project",
        didDispatch: (event) =>
          openForCurrentProject({
            focus: true,
            filePath: pathFromCommandEvent(event),
          }),
      },
      "pulsar-assistant:toggle": {
        displayName: "Pulsar Assistant: Toggle Panel",
        didDispatch: (event) =>
          openForCurrentProject({
            toggle: true,
            filePath: pathFromCommandEvent(event),
          }),
      },
      "pulsar-assistant:focus": {
        displayName: "Pulsar Assistant: Focus Panel",
        didDispatch: (event) =>
          openForCurrentProject({
            focus: true,
            filePath: pathFromCommandEvent(event),
          }),
      },
      "pulsar-assistant:edit-agents": {
        displayName: "Pulsar Assistant: Edit Agents",
        didDispatch: () => atom.workspace.open(atom.config.getUserConfigPath()),
      },
    }),
    atom.commands.add(".pulsar-assistant", {
      "core:copy": (event) => {
        const selection = window.getSelection();
        const text = selection?.toString() ?? "";
        const target = event.currentTarget as HTMLElement;
        if (text && selection?.anchorNode && target.contains(selection.anchorNode)) {
          atom.clipboard.write(text);
          event.stopPropagation();
        } else {
          event.abortKeyBinding();
        }
      },
    }),
    atom.commands.add("atom-text-editor", {
      "pulsar-assistant:add-active-file-to-prompt": {
        displayName: "Pulsar Assistant: Add Active File to Prompt",
        didDispatch: (event) => {
          void addEditorContext(event, "file");
        },
      },
      "pulsar-assistant:add-selection-to-prompt": {
        displayName: "Pulsar Assistant: Add Selection to Prompt",
        didDispatch: (event) => {
          void addEditorContext(event, "selection");
        },
      },
    }),
    atom.contextMenu.add({
      "atom-text-editor": [
        {
          label: "Open Pulsar Assistant for this Project",
          command: "pulsar-assistant:open-for-project",
        },
        {
          label: "Add Active File to Prompt",
          command: "pulsar-assistant:add-active-file-to-prompt",
        },
        {
          label: "Add Selection to Prompt",
          command: "pulsar-assistant:add-selection-to-prompt",
          shouldDisplay: () => editorHasSelection(),
        },
      ],
    }),
  );
}

export function consumeStatusBar(statusBar: StatusBar): Disposable {
  getIndicator().setStatusBar(statusBar);
  return new Disposable(() => {
    indicator?.destroy();
    indicator = null;
  });
}

export function deserializePulsarAssistantView(
  state: SerializedViewState = {},
): PulsarAssistantView | undefined {
  const root = state.projectRoot;
  if (!root || !isOpenProjectRoot(root)) return undefined;
  return createView(root, state.selectedAgentId);
}

export function deactivate(): void {
  subscriptions.dispose();
  indicator?.destroy();
  indicator = null;
  for (const view of Array.from(views)) view.destroy();
  views.clear();
}
