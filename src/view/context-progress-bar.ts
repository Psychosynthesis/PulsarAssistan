import { Disposable } from "atom";

function formatTokens(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return num.toString();
}

export class ContextProgressBar {
  readonly element: HTMLElement;
  private barTrack: HTMLElement;
  private barFill: HTMLElement;
  private label: HTMLElement;
  private tooltipDisposable: Disposable | null = null;
  private currentUsed = 0;
  private currentMax = 128_000;

  constructor() {
    this.element = document.createElement("div");
    this.element.classList.add("pulsar-assistant-context-progress");
    this.element.style.display = "none";

    this.barTrack = document.createElement("div");
    this.barTrack.classList.add("pulsar-assistant-context-track");

    this.barFill = document.createElement("div");
    this.barFill.classList.add("pulsar-assistant-context-fill");
    this.barTrack.appendChild(this.barFill);

    this.label = document.createElement("span");
    this.label.classList.add("pulsar-assistant-context-label");
    this.label.textContent = "0% context";

    this.element.appendChild(this.barTrack);
    this.element.appendChild(this.label);

    this.attachTooltip();
  }

  private attachTooltip(): void {
    if (this.tooltipDisposable) {
      this.tooltipDisposable.dispose();
      this.tooltipDisposable = null;
    }
    this.tooltipDisposable = atom.tooltips.add(this.element, {
      title: () => {
        const pct =
          this.currentMax > 0
            ? ((this.currentUsed / this.currentMax) * 100).toFixed(1)
            : "0.0";
        return `Context: ${this.currentUsed.toLocaleString()} / ${this.currentMax.toLocaleString()} tokens (${pct}%)`;
      },
      placement: "bottom",
    });
  }

  update(usedTokens: number, maxTokens: number): void {
    this.currentUsed = Math.max(0, usedTokens);
    this.currentMax = Math.max(1, maxTokens);

    const ratio = Math.min(1, this.currentUsed / this.currentMax);
    const percentage = Math.round(ratio * 100);

    this.barFill.style.width = `${(ratio * 100).toFixed(1)}%`;

    // Remove existing level classes
    this.barFill.classList.remove(
      "pulsar-assistant-context-fill-normal",
      "pulsar-assistant-context-fill-warning",
      "pulsar-assistant-context-fill-error",
    );

    if (ratio >= 0.9) {
      this.barFill.classList.add("pulsar-assistant-context-fill-error");
    } else if (ratio >= 0.7) {
      this.barFill.classList.add("pulsar-assistant-context-fill-warning");
    } else {
      this.barFill.classList.add("pulsar-assistant-context-fill-normal");
    }

    const usedFormatted = formatTokens(this.currentUsed);
    const maxFormatted = formatTokens(this.currentMax);
    this.label.textContent = `${percentage}% context (${usedFormatted}/${maxFormatted})`;
  }

  setVisible(visible: boolean): void {
    this.element.style.display = visible ? "flex" : "none";
  }

  destroy(): void {
    if (this.tooltipDisposable) {
      this.tooltipDisposable.dispose();
      this.tooltipDisposable = null;
    }
    this.element.remove();
  }
}
