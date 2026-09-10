import { CompositeDisposable } from "atom";
import * as acp from "@agentclientprotocol/sdk";
import { configOptionLabel, flattenConfigSelectOptions } from "../util";

export type SelectConfigOption = Extract<
  acp.SessionConfigOption,
  { type: "select" }
>;

// A single dropdown for one session config option; re-rendered on each update to
// track the agent's authoritative option set.
export class ConfigSelector {
  readonly element: HTMLElement;
  private button: HTMLButtonElement;
  private menu: HTMLElement;
  private tooltips = new CompositeDisposable();
  private menuVisible = false;

  constructor(
    private readonly onSelect: (configId: string, value: string) => void,
    private readonly disabled: () => boolean,
    private readonly closeSiblings: () => void,
  ) {
    this.element = document.createElement("div");
    this.element.classList.add("pulsar-assistant-config");

    this.menu = document.createElement("div");
    this.menu.classList.add("pulsar-assistant-config-menu");
    this.menu.setAttribute("role", "menu");
    this.menu.style.display = "none";

    this.button = document.createElement("button");
    this.button.classList.add("btn", "pulsar-assistant-config-trigger");
    this.button.setAttribute("aria-haspopup", "true");
    this.button.setAttribute("aria-expanded", "false");
    this.button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleMenu();
    });

    this.element.appendChild(this.menu);
    this.element.appendChild(this.button);
  }

  contains(node: Node): boolean {
    return this.element.contains(node);
  }

  focusButton(): void {
    this.button.focus();
  }

  get isOpen(): boolean {
    return this.menuVisible;
  }

  toggleMenu(): void {
    if (this.menuVisible) this.closeMenu();
    else this.openMenu();
  }

  openMenu(): void {
    if (this.button.disabled) return;
    this.closeSiblings();
    this.menuVisible = true;
    this.menu.style.display = "";
    this.button.setAttribute("aria-expanded", "true");
  }

  closeMenu(): void {
    if (!this.menuVisible) return;
    this.menuVisible = false;
    this.menu.style.display = "none";
    this.button.setAttribute("aria-expanded", "false");
  }

  updateDisabled(): void {
    this.button.disabled = this.disabled();
  }

  render(option: SelectConfigOption): void {
    this.button.textContent = configOptionLabel(option);

    this.menu.replaceChildren();
    this.tooltips.dispose();
    this.tooltips = new CompositeDisposable();

    if (option.description) {
      this.tooltips.add(
        atom.tooltips.add(this.button, {
          title: option.description,
          html: false,
          placement: "top",
          trigger: "hover",
          class: "pulsar-assistant-tooltip",
        }),
      );
    }

    for (const choice of flattenConfigSelectOptions(option.options)) {
      const item = document.createElement("button");
      item.classList.add("pulsar-assistant-config-item");
      item.setAttribute("role", "menuitemradio");
      const isActive = choice.value === option.currentValue;
      item.setAttribute("aria-checked", String(isActive));
      if (isActive) item.classList.add("is-active");

      const name = document.createElement("span");
      name.classList.add("pulsar-assistant-config-name");
      name.textContent = choice.name;
      item.appendChild(name);

      if (choice.description) {
        this.tooltips.add(
          atom.tooltips.add(item, {
            title: choice.description,
            html: false,
            placement: "left",
            class: "pulsar-assistant-tooltip",
          }),
        );
      }

      item.addEventListener("click", () => {
        this.closeMenu();
        this.onSelect(option.id, choice.value);
      });
      this.menu.appendChild(item);
    }

    this.updateDisabled();
  }

  dispose(): void {
    this.closeMenu();
    this.tooltips.dispose();
    this.element.remove();
  }
}
