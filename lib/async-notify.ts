/**
 * Telegram async-run attribution and notification helpers
 * Zones: telegram, pi agent, async runtime
 * Owns Telegram-side notices for attributable async runs started during an active Telegram turn
 */

import type { PendingTelegramTurn } from "./queue.ts";

const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
const GLOBAL_UNSUBSCRIBE_STORE_KEY = "__piTelegramAsyncNotifyUnsubscribes__";
const DEFAULT_SUMMARY_LIMIT = 2000;

export type TelegramAsyncRunNoticeState =
  | "completed"
  | "failed"
  | "paused"
  | "needs_attention";

export interface TelegramAsyncRunAttribution {
  runId: string;
  chatId: number;
  replyToMessageId: number | undefined;
  notifiedStates: Set<TelegramAsyncRunNoticeState>;
}

export interface TelegramAsyncStartedEvent {
  id?: string;
}

export interface TelegramAsyncCompletedEvent {
  id?: string;
  agent?: string;
  success?: boolean;
  summary?: string;
  exitCode?: number;
  state?: string;
}

export interface TelegramAsyncControlEvent {
  source?: "foreground" | "async";
  event?: {
    type?: string;
    runId?: string;
    agent?: string;
    message?: string;
  };
}

export interface TelegramAsyncNotificationRuntimeDeps {
  getActiveTurn: () => PendingTelegramTurn | undefined;
  isCurrentOwner: () => boolean;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
  ) => Promise<unknown>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
  summaryLimit?: number;
}

export interface TelegramAsyncNotificationRuntime {
  clear: () => void;
  getAttribution: (runId: string) => TelegramAsyncRunAttribution | undefined;
  handleStarted: (payload: unknown) => void;
  handleCompleted: (payload: unknown) => Promise<void>;
  handleControl: (payload: unknown) => Promise<void>;
}

export interface TelegramAsyncNotificationSessionHooks<
  TStartEvent,
  TShutdownEvent,
  TContext,
> {
  onSessionStart: (event: TStartEvent, ctx: TContext) => Promise<void>;
  onSessionShutdown: (event: TShutdownEvent, ctx: TContext) => Promise<void>;
}

export interface TelegramEventBusLike {
  on: (event: string, handler: (payload: unknown) => void) => () => void;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getAsyncRunId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("id" in payload)) {
    return undefined;
  }
  const value = Reflect.get(payload, "id");
  return isNonEmptyString(value) ? value.trim() : undefined;
}

function getAttributedActiveTurn(
  turn: PendingTelegramTurn | undefined,
): TelegramAsyncRunAttribution | undefined {
  if (!turn || turn.guestQueryId) return undefined;
  return {
    runId: "",
    chatId: turn.chatId,
    replyToMessageId: turn.replyToMessageId,
    notifiedStates: new Set<TelegramAsyncRunNoticeState>(),
  };
}

function formatAsyncRunIdSuffix(runId: string): string {
  const shortId = runId.length > 8 ? runId.slice(0, 8) : runId;
  return shortId ? ` [${shortId}]` : "";
}

function trimAsyncNoticeSummary(
  summary: string | undefined,
  limit: number,
): string | undefined {
  if (!isNonEmptyString(summary)) return undefined;
  const trimmed = summary.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function isPausedAsyncCompletion(payload: TelegramAsyncCompletedEvent): boolean {
  return payload.success === false &&
    (payload.state === "paused" || payload.exitCode === 0);
}

export function buildTelegramAsyncCompletionNotice(
  payload: TelegramAsyncCompletedEvent,
  options?: { summaryLimit?: number },
): { state: "completed" | "failed" | "paused"; text: string } | undefined {
  const runId = getAsyncRunId(payload);
  if (!runId) return undefined;
  const agent = isNonEmptyString(payload.agent) ? payload.agent.trim() : "task";
  const summary = trimAsyncNoticeSummary(
    payload.summary,
    options?.summaryLimit ?? DEFAULT_SUMMARY_LIMIT,
  );
  const state = isPausedAsyncCompletion(payload)
    ? "paused"
    : payload.success
      ? "completed"
      : "failed";
  const heading = `Background task ${state}: ${agent}${formatAsyncRunIdSuffix(runId)}`;
  return {
    state,
    text: summary ? `${heading}\n\n${summary}` : heading,
  };
}

export function buildTelegramAsyncNeedsAttentionNotice(
  payload: TelegramAsyncControlEvent,
): { state: "needs_attention"; runId: string; text: string } | undefined {
  if (payload.source !== "async") return undefined;
  const event = payload.event;
  if (!event || event.type !== "needs_attention" || !isNonEmptyString(event.runId)) {
    return undefined;
  }
  const runId = event.runId.trim();
  const agent = isNonEmptyString(event.agent) ? event.agent.trim() : "task";
  const reason = isNonEmptyString(event.message) ? event.message.trim() : undefined;
  const heading = `Background task needs attention: ${agent}${formatAsyncRunIdSuffix(runId)}`;
  return {
    state: "needs_attention",
    runId,
    text: reason ? `${heading}\n\n${reason}` : heading,
  };
}

async function deliverAsyncRunNotice(
  attribution: TelegramAsyncRunAttribution,
  state: TelegramAsyncRunNoticeState,
  text: string,
  deps: Pick<
    TelegramAsyncNotificationRuntimeDeps,
    "sendTextReply" | "recordRuntimeEvent"
  >,
): Promise<void> {
  try {
    await deps.sendTextReply(
      attribution.chatId,
      attribution.replyToMessageId,
      text,
    );
  } catch (error) {
    deps.recordRuntimeEvent?.("async-notify", error, {
      runId: attribution.runId,
      state,
      chatId: attribution.chatId,
      replyToMessageId: attribution.replyToMessageId,
    });
  }
}

export function createTelegramAsyncNotificationRuntime(
  deps: TelegramAsyncNotificationRuntimeDeps,
): TelegramAsyncNotificationRuntime {
  const attributedRuns = new Map<string, TelegramAsyncRunAttribution>();
  const summaryLimit = deps.summaryLimit ?? DEFAULT_SUMMARY_LIMIT;

  return {
    clear: () => {
      attributedRuns.clear();
    },
    getAttribution: (runId) => attributedRuns.get(runId),
    handleStarted: (payload) => {
      const runId = getAsyncRunId(payload);
      if (!runId) return;
      const baseAttribution = getAttributedActiveTurn(deps.getActiveTurn());
      if (!baseAttribution) return;
      attributedRuns.set(runId, {
        ...baseAttribution,
        runId,
      });
    },
    handleCompleted: async (payload) => {
      const notice = buildTelegramAsyncCompletionNotice(
        payload as TelegramAsyncCompletedEvent,
        { summaryLimit },
      );
      if (!notice) return;
      const runId = getAsyncRunId(payload);
      if (!runId) return;
      const attribution = attributedRuns.get(runId);
      if (!attribution) return;
      if (attribution.notifiedStates.has(notice.state)) {
        attributedRuns.delete(runId);
        return;
      }
      attribution.notifiedStates.add(notice.state);
      if (deps.isCurrentOwner()) {
        await deliverAsyncRunNotice(attribution, notice.state, notice.text, deps);
      }
      attributedRuns.delete(runId);
    },
    handleControl: async (payload) => {
      const notice = buildTelegramAsyncNeedsAttentionNotice(
        payload as TelegramAsyncControlEvent,
      );
      if (!notice) return;
      const attribution = attributedRuns.get(notice.runId);
      if (!attribution || attribution.notifiedStates.has(notice.state)) return;
      attribution.notifiedStates.add(notice.state);
      if (!deps.isCurrentOwner()) return;
      await deliverAsyncRunNotice(attribution, notice.state, notice.text, deps);
    },
  };
}

export function createTelegramAsyncNotificationSessionHooks<
  TStartEvent,
  TShutdownEvent,
  TContext,
>(
  deps: {
    clear: () => void;
  },
): TelegramAsyncNotificationSessionHooks<TStartEvent, TShutdownEvent, TContext> {
  return {
    onSessionStart: async () => {
      deps.clear();
    },
    onSessionShutdown: async () => {
      deps.clear();
    },
  };
}

export function bindTelegramAsyncNotificationEvents(
  eventBus: TelegramEventBusLike,
  runtime: Pick<
    TelegramAsyncNotificationRuntime,
    "handleStarted" | "handleCompleted" | "handleControl"
  >,
): Array<() => void> {
  const globalStore = globalThis as Record<string, unknown>;
  const previousUnsubscribes = globalStore[GLOBAL_UNSUBSCRIBE_STORE_KEY];
  if (Array.isArray(previousUnsubscribes)) {
    for (const unsubscribe of previousUnsubscribes) {
      if (typeof unsubscribe !== "function") continue;
      try {
        unsubscribe();
      } catch {
        // Best-effort cleanup for stale reload handlers.
      }
    }
  }
  const unsubscribes = [
    eventBus.on(SUBAGENT_ASYNC_STARTED_EVENT, (payload) => {
      runtime.handleStarted(payload);
    }),
    eventBus.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (payload) => {
      void runtime.handleCompleted(payload);
    }),
    eventBus.on(SUBAGENT_CONTROL_EVENT, (payload) => {
      void runtime.handleControl(payload);
    }),
  ];
  globalStore[GLOBAL_UNSUBSCRIBE_STORE_KEY] = unsubscribes;
  return unsubscribes;
}
