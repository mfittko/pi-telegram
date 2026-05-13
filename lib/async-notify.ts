/**
 * Telegram async follow-up attribution helpers
 * Zones: telegram, pi agent, async runtime
 * Owns async run attribution and pending no-turn parent follow-up mirroring targets for Telegram-started async work
 */

import type { PendingTelegramTurn } from "./queue.ts";

const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
const GLOBAL_UNSUBSCRIBE_STORE_KEY = "__piTelegramAsyncFollowupUnsubscribes__";

type TelegramAsyncFollowupUnsubscribeStore = WeakMap<
  TelegramEventBusLike,
  Array<() => void>
>;

type TelegramAsyncFollowupKind = "needs_attention" | "completion";

export interface TelegramAsyncStartedEvent {
  id?: string;
}

export interface TelegramAsyncCompletedEvent {
  id?: string;
}

export interface TelegramAsyncControlEvent {
  source?: "foreground" | "async";
  event?: {
    type?: string;
    runId?: string;
  };
}

export interface TelegramAsyncFollowupTarget {
  chatId: number;
  replyToMessageId: number | undefined;
}

interface TelegramAsyncAttributedRun extends TelegramAsyncFollowupTarget {
  runId: string;
}

interface TelegramPendingAsyncFollowup {
  runId: string;
  kind: TelegramAsyncFollowupKind;
}

export interface TelegramAsyncFollowupRuntimeDeps {
  getActiveTurn: () => PendingTelegramTurn | undefined;
  isCurrentOwner: () => boolean;
}

export interface TelegramAsyncFollowupRuntime {
  clear: () => void;
  handleStarted: (payload: unknown) => void;
  handleCompleted: (payload: unknown) => void;
  handleControl: (payload: unknown) => void;
  peekPendingFollowupTarget: () => TelegramAsyncFollowupTarget | undefined;
  consumePendingFollowupTarget: () => TelegramAsyncFollowupTarget | undefined;
}

export interface TelegramAsyncFollowupSessionHooks<
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

function getAsyncControlRunId(payload: TelegramAsyncControlEvent): string | undefined {
  if (payload.source !== "async") return undefined;
  const event = payload.event;
  if (!event || event.type !== "needs_attention" || !isNonEmptyString(event.runId)) {
    return undefined;
  }
  return event.runId.trim();
}

function getAttributedActiveTurn(
  turn: PendingTelegramTurn | undefined,
): TelegramAsyncFollowupTarget | undefined {
  if (!turn || turn.guestQueryId) return undefined;
  return {
    chatId: turn.chatId,
    replyToMessageId: turn.replyToMessageId,
  };
}

function hasPendingKind(
  pending: TelegramPendingAsyncFollowup[],
  runId: string,
  kind: TelegramAsyncFollowupKind,
): boolean {
  return pending.some((entry) => entry.runId === runId && entry.kind === kind);
}

function deletePendingEntry(
  pending: TelegramPendingAsyncFollowup[],
  runId: string,
  kind: TelegramAsyncFollowupKind,
): void {
  const index = pending.findIndex((entry) => entry.runId === runId && entry.kind === kind);
  if (index >= 0) pending.splice(index, 1);
}

export function createTelegramAsyncFollowupRuntime(
  deps: TelegramAsyncFollowupRuntimeDeps,
): TelegramAsyncFollowupRuntime {
  const attributedRuns = new Map<string, TelegramAsyncAttributedRun>();
  const pendingFollowups: TelegramPendingAsyncFollowup[] = [];
  const deliveredStates = new Map<string, Set<TelegramAsyncFollowupKind>>();

  function hasDeliveredKind(
    runId: string,
    kind: TelegramAsyncFollowupKind,
  ): boolean {
    return deliveredStates.get(runId)?.has(kind) ?? false;
  }

  function markDeliveredKind(
    runId: string,
    kind: TelegramAsyncFollowupKind,
  ): void {
    const current = deliveredStates.get(runId) ?? new Set<TelegramAsyncFollowupKind>();
    current.add(kind);
    deliveredStates.set(runId, current);
  }

  function markPending(runId: string, kind: TelegramAsyncFollowupKind): void {
    if (!attributedRuns.has(runId) || hasDeliveredKind(runId, kind)) return;
    if (hasPendingKind(pendingFollowups, runId, kind)) return;
    if (kind === "completion") {
      deletePendingEntry(pendingFollowups, runId, "needs_attention");
    }
    pendingFollowups.push({ runId, kind });
  }

  return {
    clear: () => {
      attributedRuns.clear();
      pendingFollowups.splice(0, pendingFollowups.length);
      deliveredStates.clear();
    },
    handleStarted: (payload) => {
      const runId = getAsyncRunId(payload);
      if (!runId || !deps.isCurrentOwner()) return;
      const target = getAttributedActiveTurn(deps.getActiveTurn());
      if (!target) return;
      attributedRuns.set(runId, { runId, ...target });
    },
    handleCompleted: (payload) => {
      const runId = getAsyncRunId(payload);
      if (!runId) return;
      markPending(runId, "completion");
    },
    handleControl: (payload) => {
      const runId = getAsyncControlRunId(payload as TelegramAsyncControlEvent);
      if (!runId) return;
      markPending(runId, "needs_attention");
    },
    peekPendingFollowupTarget: () => {
      for (const next of pendingFollowups) {
        const attribution = attributedRuns.get(next.runId);
        if (!attribution) continue;
        return {
          chatId: attribution.chatId,
          replyToMessageId: attribution.replyToMessageId,
        };
      }
      return undefined;
    },
    consumePendingFollowupTarget: () => {
      while (pendingFollowups.length > 0) {
        const next = pendingFollowups.shift();
        if (!next) return undefined;
        const attribution = attributedRuns.get(next.runId);
        if (!attribution) continue;
        markDeliveredKind(next.runId, next.kind);
        if (next.kind === "completion") {
          attributedRuns.delete(next.runId);
          deliveredStates.delete(next.runId);
        }
        return {
          chatId: attribution.chatId,
          replyToMessageId: attribution.replyToMessageId,
        };
      }
      return undefined;
    },
  };
}

export function createTelegramAsyncFollowupSessionHooks<
  TStartEvent,
  TShutdownEvent,
  TContext,
>(
  deps: Pick<TelegramAsyncFollowupRuntime, "clear">,
): TelegramAsyncFollowupSessionHooks<TStartEvent, TShutdownEvent, TContext> {
  return {
    onSessionStart: async () => {
      deps.clear();
    },
    onSessionShutdown: async () => {
      deps.clear();
    },
  };
}

function getGlobalAsyncFollowupUnsubscribeStore(): TelegramAsyncFollowupUnsubscribeStore {
  const globalStore = globalThis as Record<string, unknown>;
  const existing = globalStore[GLOBAL_UNSUBSCRIBE_STORE_KEY];
  if (existing instanceof WeakMap) {
    return existing as TelegramAsyncFollowupUnsubscribeStore;
  }
  const nextStore: TelegramAsyncFollowupUnsubscribeStore = new WeakMap();
  globalStore[GLOBAL_UNSUBSCRIBE_STORE_KEY] = nextStore;
  return nextStore;
}

export function bindTelegramAsyncFollowupEvents(
  eventBus: TelegramEventBusLike,
  runtime: Pick<
    TelegramAsyncFollowupRuntime,
    "handleStarted" | "handleCompleted" | "handleControl"
  >,
): Array<() => void> {
  const unsubscribeStore = getGlobalAsyncFollowupUnsubscribeStore();
  const previousUnsubscribes = unsubscribeStore.get(eventBus);
  if (previousUnsubscribes) {
    for (const unsubscribe of previousUnsubscribes) {
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
      runtime.handleCompleted(payload);
    }),
    eventBus.on(SUBAGENT_CONTROL_EVENT, (payload) => {
      runtime.handleControl(payload);
    }),
  ];
  unsubscribeStore.set(eventBus, unsubscribes);
  return unsubscribes.map((unsubscribe) => {
    return () => {
      unsubscribe();
      if (unsubscribeStore.get(eventBus) === unsubscribes) {
        unsubscribeStore.delete(eventBus);
      }
    };
  });
}
