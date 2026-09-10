import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true });

export function renderMarkdown(el: HTMLElement, text: string): void {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text) as string);
}
