import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true });

// marked 15+ uses Array.prototype.at. Pulsar's renderer (and older
// Chromium) may not have it; esbuild does not polyfill.
function shimArrayAt(): void {
  if (typeof Array.prototype.at === "function") return;
  Object.defineProperty(Array.prototype, "at", {
    value(this: ArrayLike<unknown>, n: number) {
      const i = Math.trunc(n) || 0;
      const k = i >= 0 ? i : this.length + i;
      if (k < 0 || k >= this.length) return undefined;
      return this[k];
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

export function renderMarkdown(el: HTMLElement, text: string): void {
  shimArrayAt();
  try {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text) as string);
  } catch (error) {
    console.error("[pulsar-assistant] markdown parse failed", error);
    el.textContent = text;
  }
}
