import { Panel } from "atom";

export type TestCommandModalOptions = {
  projectRoot: string;
  currentCommand: string | null;
  onSave: (command: string | null) => void;
};

export class TestCommandModal {
  private panel: Panel | null = null;
  readonly element: HTMLElement;
  private input!: HTMLInputElement;
  private keydownHandler: (event: KeyboardEvent) => void;

  private constructor(private readonly options: TestCommandModalOptions) {
    this.element = document.createElement("div");
    this.element.classList.add(
      "pulsar-assistant-projects-modal",
      "pulsar-assistant-test-command-modal",
      "overlay",
      "modal",
    );
    this.element.style.maxWidth = "520px";
    this.element.style.overflow = "visible";

    this.keydownHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        this.close();
      }
    };
  }

  static show(options: TestCommandModalOptions): TestCommandModal {
    const modal = new TestCommandModal(options);
    modal.render();
    modal.panel = atom.workspace.addModalPanel({
      item: modal.element,
      visible: true,
    });
    document.addEventListener("keydown", modal.keydownHandler, true);
    modal.input.focus();
    modal.input.select();
    return modal;
  }

  close(): void {
    document.removeEventListener("keydown", this.keydownHandler, true);
    this.panel?.destroy();
    this.panel = null;
    this.element.remove();
  }

  private save(): void {
    const command = this.input.value.trim();
    this.options.onSave(command.length > 0 ? command : null);
    this.close();
  }

  private render(): void {
    this.element.innerHTML = "";

    const header = document.createElement("div");
    header.classList.add("pulsar-assistant-modal-header");

    const title = document.createElement("h2");
    title.classList.add("pulsar-assistant-modal-title");
    title.textContent = "Set test command";

    const closeBtn = document.createElement("button");
    closeBtn.classList.add(
      "btn",
      "btn-default",
      "icon",
      "icon-x",
      "pulsar-assistant-modal-close",
    );
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", () => this.close());

    header.appendChild(title);
    header.appendChild(closeBtn);
    this.element.appendChild(header);

    const label = document.createElement("label");
    label.classList.add("pulsar-assistant-test-command-label");
    label.textContent = "Command used by the run_tests tool in this project";
    label.htmlFor = "pulsar-assistant-test-command-input";
    label.style.display = "block";
    label.style.marginBottom = "6px";

    this.input = document.createElement("input");
    this.input.id = "pulsar-assistant-test-command-input";
    this.input.type = "text";
    this.input.classList.add(
      "input-text",
      "native-key-bindings",
      "pulsar-assistant-test-command-input",
    );
    this.input.placeholder = "npm test";
    this.input.spellcheck = false;
    this.input.style.width = "100%";
    this.input.style.boxSizing = "border-box";
    this.input.value = this.options.currentCommand ?? "";
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.save();
      }
    });

    const hint = document.createElement("div");
    hint.classList.add("pulsar-assistant-test-command-hint");
    hint.textContent =
      "Run from the project root without a shell. Leave empty to clear.";
    hint.style.marginTop = "8px";
    hint.style.color = "var(--text-color-subtle)";
    hint.style.fontSize = "0.85em";

    const actions = document.createElement("div");
    actions.classList.add("pulsar-assistant-modal-actions");
    actions.style.display = "flex";
    actions.style.justifyContent = "flex-end";
    actions.style.gap = "8px";
    actions.style.marginTop = "16px";

    const cancelBtn = document.createElement("button");
    cancelBtn.classList.add("btn");
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = document.createElement("button");
    saveBtn.classList.add("btn", "btn-primary");
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => this.save());

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    this.element.appendChild(label);
    this.element.appendChild(this.input);
    this.element.appendChild(hint);
    this.element.appendChild(actions);
  }
}
