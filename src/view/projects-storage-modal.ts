import * as fs from "fs";
import * as path from "path";
import { Panel } from "atom";
import {
  DEFAULT_MODEL_CONTEXT_WINDOWS,
  FALLBACK_CONTEXT_WINDOW,
} from "../token-estimate";
import { safeProjectKey } from "../session-storage";

interface ProjectStorageItem {
  projectRoot: string;
  storageDir?: string;
  sessionCount: number;
  hasTree: boolean;
  diskSizeBytes: number;
  inConfig: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

async function computeDirSize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await computeDirSize(full);
      } else if (entry.isFile()) {
        try {
          const st = await fs.promises.stat(full);
          total += st.size;
        } catch {}
      }
    }
  } catch {}
  return total;
}

async function scanProjectStorage(
  storageDir: string,
): Promise<{ projectRoot: string; sessionCount: number; hasTree: boolean }> {
  let projectRoot = "";
  let sessionCount = 0;
  let hasTree = false;

  // Check tree.json
  const treePath = path.join(storageDir, "tree.json");
  try {
    const raw = await fs.promises.readFile(treePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.projectRoot === "string") {
      projectRoot = parsed.projectRoot;
      hasTree = true;
    }
  } catch {}

  // Check sessions
  const sessionsDir = path.join(storageDir, "sessions");
  try {
    const files = await fs.promises.readdir(sessionsDir);
    const sessionFiles = files.filter((f) => f.endsWith(".json"));
    sessionCount = sessionFiles.length;

    if (!projectRoot && sessionFiles.length > 0) {
      try {
        const rawFirst = await fs.promises.readFile(
          path.join(sessionsDir, sessionFiles[0]),
          "utf8",
        );
        const parsedFirst = JSON.parse(rawFirst);
        if (parsedFirst && typeof parsedFirst.projectRoot === "string") {
          projectRoot = parsedFirst.projectRoot;
        }
      } catch {}
    }
  } catch {}

  if (!projectRoot) {
    projectRoot = path.basename(storageDir);
  }

  return { projectRoot, sessionCount, hasTree };
}

export class ProjectsStorageModal {
  private panel: Panel | null = null;
  readonly element: HTMLElement;
  private keydownHandler: (event: KeyboardEvent) => void;

  constructor() {
    this.element = document.createElement("div");
    this.element.classList.add("pulsar-assistant-projects-modal", "overlay", "modal");

    this.keydownHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        this.close();
      }
    };
  }

  static show(): ProjectsStorageModal {
    const modal = new ProjectsStorageModal();
    modal.render();
    modal.panel = atom.workspace.addModalPanel({
      item: modal.element,
      visible: true,
    });
    document.addEventListener("keydown", modal.keydownHandler);
    return modal;
  }

  close(): void {
    document.removeEventListener("keydown", this.keydownHandler);
    if (this.panel) {
      this.panel.destroy();
      this.panel = null;
    }
    this.element.remove();
  }

  private async render(): Promise<void> {
    this.element.innerHTML = "";

    // Header
    const header = document.createElement("div");
    header.classList.add("pulsar-assistant-modal-header");

    const title = document.createElement("h2");
    title.classList.add("pulsar-assistant-modal-title");
    title.textContent = "Pulsar Assistant: Projects & Storage";

    const closeBtn = document.createElement("button");
    closeBtn.classList.add("btn", "btn-default", "icon", "icon-x", "pulsar-assistant-modal-close");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", () => this.close());

    header.appendChild(title);
    header.appendChild(closeBtn);
    this.element.appendChild(header);

    const body = document.createElement("div");
    body.classList.add("pulsar-assistant-modal-body");
    this.element.appendChild(body);

    // Section 1: Model Context Windows
    this.renderContextWindowsSection(body);

    // Section 2: Projects & Storage
    await this.renderProjectsSection(body);
  }

  private renderContextWindowsSection(container: HTMLElement): void {
    const section = document.createElement("div");
    section.classList.add("pulsar-assistant-modal-section");

    const secHeader = document.createElement("div");
    secHeader.classList.add("pulsar-assistant-section-header");

    const title = document.createElement("h3");
    title.textContent = "Model Context Windows";

    const editBtn = document.createElement("button");
    editBtn.classList.add("btn", "btn-sm");
    editBtn.textContent = "Edit in config.cson\u2026";
    editBtn.addEventListener("click", () => {
      void atom.workspace.open(atom.config.getUserConfigPath());
    });

    secHeader.appendChild(title);
    secHeader.appendChild(editBtn);
    section.appendChild(secHeader);

    const desc = document.createElement("p");
    desc.classList.add("text-muted");
    desc.textContent =
      "Token context limits used for calculating dialog capacity. Add custom limits in config.cson under `pulsar-assistant.modelContextWindows`.";
    section.appendChild(desc);

    const customWindows =
      (atom.config.get("pulsar-assistant.modelContextWindows") as
        | Record<string, number>
        | undefined) || {};

    const tableWrap = document.createElement("div");
    tableWrap.classList.add("pulsar-assistant-table-scroll");

    const table = document.createElement("table");
    table.classList.add("pulsar-assistant-table");

    const thead = document.createElement("thead");
    thead.innerHTML = `
      <tr>
        <th>Model / Family</th>
        <th>Context Limit</th>
        <th>Source</th>
      </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    // Custom items first
    for (const [name, limit] of Object.entries(customWindows)) {
      if (typeof limit === "number") {
        const tr = document.createElement("tr");
        tr.classList.add("pulsar-assistant-table-custom-row");
        tr.innerHTML = `
          <td><strong>${name}</strong></td>
          <td>${limit.toLocaleString()} tokens</td>
          <td><span class="badge badge-info">custom</span></td>
        `;
        tbody.appendChild(tr);
      }
    }

    // Default items
    for (const [name, limit] of Object.entries(DEFAULT_MODEL_CONTEXT_WINDOWS)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${name}</td>
        <td>${limit.toLocaleString()} tokens</td>
        <td><span class="text-muted">default</span></td>
      `;
      tbody.appendChild(tr);
    }

    // Fallback row
    const fallbackTr = document.createElement("tr");
    fallbackTr.innerHTML = `
      <td><em>Fallback (other models)</em></td>
      <td>${FALLBACK_CONTEXT_WINDOW.toLocaleString()} tokens</td>
      <td><span class="text-muted">fallback</span></td>
    `;
    tbody.appendChild(fallbackTr);

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    section.appendChild(tableWrap);

    container.appendChild(section);
  }

  private async renderProjectsSection(container: HTMLElement): Promise<void> {
    const section = document.createElement("div");
    section.classList.add("pulsar-assistant-modal-section");

    const title = document.createElement("h3");
    title.textContent = "Saved Projects & Storage";
    section.appendChild(title);

    const desc = document.createElement("p");
    desc.classList.add("text-muted");
    desc.textContent =
      "Stored sessions, conversation history, and B-tree file indexing cache on disk.";
    section.appendChild(desc);

    const loading = document.createElement("div");
    loading.classList.add("text-muted");
    loading.textContent = "Scanning project storage\u2026";
    section.appendChild(loading);

    container.appendChild(section);

    // Scan disk projects
    const configDir = atom.getConfigDirPath();
    const projectsBaseDir = path.join(
      configDir,
      "storage",
      "pulsar-assistant",
      "projects",
    );

    const projectItems = new Map<string, ProjectStorageItem>();

    try {
      const dirEntries = await fs.promises.readdir(projectsBaseDir, {
        withFileTypes: true,
      });
      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        const projectStorageDir = path.join(projectsBaseDir, entry.name);
        const meta = await scanProjectStorage(projectStorageDir);
        const size = await computeDirSize(projectStorageDir);

        projectItems.set(meta.projectRoot, {
          projectRoot: meta.projectRoot,
          storageDir: projectStorageDir,
          sessionCount: meta.sessionCount,
          hasTree: meta.hasTree,
          diskSizeBytes: size,
          inConfig: false,
        });
      }
    } catch {}

    // Check config projects
    const configProjects =
      (atom.config.get("pulsar-assistant.projects") as
        | Record<string, unknown>
        | undefined) || {};

    for (const projectPath of Object.keys(configProjects)) {
      const existing = projectItems.get(projectPath);
      if (existing) {
        existing.inConfig = true;
      } else {
        const expectedDir = path.join(
          projectsBaseDir,
          safeProjectKey(projectPath),
        );
        let existsOnDisk = false;
        let size = 0;
        try {
          await fs.promises.access(expectedDir);
          existsOnDisk = true;
          size = await computeDirSize(expectedDir);
        } catch {}

        projectItems.set(projectPath, {
          projectRoot: projectPath,
          storageDir: existsOnDisk ? expectedDir : undefined,
          sessionCount: 0,
          hasTree: false,
          diskSizeBytes: size,
          inConfig: true,
        });
      }
    }

    loading.remove();

    if (projectItems.size === 0) {
      const empty = document.createElement("div");
      empty.classList.add("pulsar-assistant-empty-state");
      empty.textContent = "No stored projects or sessions found.";
      section.appendChild(empty);
      return;
    }

    const tableWrap = document.createElement("div");
    tableWrap.classList.add("pulsar-assistant-table-scroll");

    const table = document.createElement("table");
    table.classList.add("pulsar-assistant-table");

    const thead = document.createElement("thead");
    thead.innerHTML = `
      <tr>
        <th>Project Root</th>
        <th>Sessions</th>
        <th>Tree Index</th>
        <th>Disk Size</th>
        <th>Actions</th>
      </tr>
    `;
    table.appendChild(thead);

    const tbody = document.createElement("tbody");

    for (const item of Array.from(projectItems.values())) {
      const row = document.createElement("tr");

      const tdRoot = document.createElement("td");
      tdRoot.classList.add("pulsar-assistant-project-path");
      tdRoot.textContent = item.projectRoot;
      tdRoot.title = item.projectRoot;
      row.appendChild(tdRoot);

      const tdSessions = document.createElement("td");
      tdSessions.textContent =
        item.sessionCount > 0 ? `${item.sessionCount} sessions` : "0";
      row.appendChild(tdSessions);

      const tdTree = document.createElement("td");
      tdTree.textContent = item.hasTree ? "tree.json" : "\u2014";
      row.appendChild(tdTree);

      const tdSize = document.createElement("td");
      tdSize.textContent = formatBytes(item.diskSizeBytes);
      row.appendChild(tdSize);

      const tdActions = document.createElement("td");
      const delBtn = document.createElement("button");
      delBtn.classList.add(
        "btn",
        "btn-error",
        "btn-sm",
        "inline-block-tight",
        "icon",
        "icon-x",
      );
      delBtn.setAttribute("aria-label", "Delete project data");
      delBtn.title = "Delete project data";

      delBtn.addEventListener("click", () => {
        atom.confirm(
          {
            message: "Delete project data?",
            detail: `Are you sure you want to delete stored sessions and data for:\n${item.projectRoot}\n\nThis permanently removes cached sessions and configuration for this project.`,
            buttons: ["Delete", "Cancel"],
          },
          (response) => {
            if (response === 0) {
              void this.deleteProjectData(item, row);
            }
          },
        );
      });

      tdActions.appendChild(delBtn);
      row.appendChild(tdActions);
      tbody.appendChild(row);
    }

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    section.appendChild(tableWrap);
  }

  private async deleteProjectData(
    item: ProjectStorageItem,
    rowElement: HTMLElement,
  ): Promise<void> {
    try {
      // 1. Remove storage directory from disk
      if (item.storageDir) {
        await fs.promises.rm(item.storageDir, { recursive: true, force: true });
      }

      // 2. Remove from pulsar-assistant.projects in user config
      const projects =
        (atom.config.get("pulsar-assistant.projects") as
          | Record<string, unknown>
          | undefined) || {};
      if (projects[item.projectRoot] !== undefined) {
        const updated = { ...projects };
        delete updated[item.projectRoot];
        atom.config.set("pulsar-assistant.projects", updated);
      }

      // 3. Remove row from table
      rowElement.remove();
      atom.notifications.addSuccess("Project storage deleted", {
        description: item.projectRoot,
      });
    } catch (err) {
      atom.notifications.addError("Failed to delete project storage", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
