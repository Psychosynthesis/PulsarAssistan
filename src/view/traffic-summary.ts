import { CompositeDisposable, Disposable } from "atom";
import type { PulsarAssistantView } from "./agent-view";

type Traffic = {
  requests: number;
  sentBytes: number;
  receivedBytes: number;
};

type BuiltinSessionNewDetail = {
  projectRoot: string;
  sessionId: string;
};

type ApiTrafficDetail = BuiltinSessionNewDetail & {
  requestBytes: number;
  responseBytes: number;
};

function emptyTraffic(): Traffic {
  return { requests: 0, sentBytes: 0, receivedBytes: 0 };
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTraffic(traffic: Traffic): string {
  return `${traffic.requests} req \u00b7 \u2191 ${formatByteCount(
    traffic.sentBytes,
  )} \u00b7 \u2193 ${formatByteCount(traffic.receivedBytes)}`;
}

// Displays a compact per-panel API traffic summary in the header's More row.
// Traffic is emitted by the builtin OpenAI-compatible agent as document events
// because that is the only agent whose HTTP calls happen inside this package.
export function attachTrafficSummary(view: PulsarAssistantView): Disposable {
  const root = view
    .getElement()
    .querySelector<HTMLElement>(".pulsar-assistant-header-row2");
  if (!root) return new Disposable(() => {});

  const span = document.createElement("span");
  span.classList.add("pulsar-assistant-traffic");
  span.style.display = "none";
  const live = root.querySelector(".pulsar-assistant-token-usage");
  root.insertBefore(span, live);

  const bySession = new Map<string, Traffic>();
  let activeSessionId: string | null = null;

  const render = (): void => {
    const traffic = activeSessionId
      ? bySession.get(activeSessionId)
      : undefined;
    const text =
      traffic && traffic.requests > 0 ? formatTraffic(traffic) : "";
    span.textContent = text;
    span.style.display = text ? "" : "none";
    root.classList.toggle("has-traffic", text !== "");
  };

  const reset = (): void => {
    activeSessionId = null;
    bySession.clear();
    render();
  };

  const onSessionNew = (event: Event): void => {
    const detail = (event as CustomEvent<BuiltinSessionNewDetail>).detail;
    if (!detail || detail.projectRoot !== view.projectRoot) return;
    activeSessionId = detail.sessionId;
    bySession.set(detail.sessionId, emptyTraffic());
    render();
  };

  const onApiTraffic = (event: Event): void => {
    const detail = (event as CustomEvent<ApiTrafficDetail>).detail;
    if (!detail || detail.projectRoot !== view.projectRoot) return;
    const existing = bySession.get(detail.sessionId) ?? emptyTraffic();
    existing.requests += 1;
    existing.sentBytes += detail.requestBytes;
    existing.receivedBytes += detail.responseBytes;
    bySession.set(detail.sessionId, existing);
    activeSessionId = detail.sessionId;
    render();
  };

  document.addEventListener("pulsar-assistant:builtin-session-new", onSessionNew);
  document.addEventListener("pulsar-assistant:api-traffic", onApiTraffic);

  const picker = view
    .getElement()
    .querySelector<HTMLElement>(".pulsar-assistant-picker");
  let lastPickerLabel = picker?.textContent ?? "";
  const observer = new MutationObserver(() => {
    const nextLabel = picker?.textContent ?? "";
    if (nextLabel !== lastPickerLabel) {
      lastPickerLabel = nextLabel;
      reset();
    }
  });
  if (picker) {
    observer.observe(picker, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  const disposables = new CompositeDisposable();
  disposables.add(
    new Disposable(() =>
      document.removeEventListener(
        "pulsar-assistant:builtin-session-new",
        onSessionNew,
      ),
    ),
    new Disposable(() =>
      document.removeEventListener("pulsar-assistant:api-traffic", onApiTraffic),
    ),
    new Disposable(() => observer.disconnect()),
    new Disposable(() => span.remove()),
  );
  return disposables;
}
