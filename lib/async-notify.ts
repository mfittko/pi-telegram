/**
 * Telegram async follow-up attribution helpers
 * Zones: telegram, pi agent, async runtime
 * Owns async run attribution and pending no-turn parent follow-up mirroring targets for Telegram-started async work
 */

import type { PendingTelegramTurn } from "./queue.ts";

const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
const SUBAGENT_NOTIFY_CUSTOM_TYPE = "subagent-notify";
const SUBAGENT_CONTROL_NOTICE_CUSTOM_TYPE = "subagent_control_notice";
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
  handleMessageStart: (message: unknown) => void;
  hasCurrentTurnFollowupTarget: () => boolean;
  clearCurrentTurn: () => void;
  peekPendingFollowupTarget: () => TelegramAsyncFollowupTarget | undefined;
  consumePendingFollowupTarget: () => TelegramAsyncFollowupTarget | undefined;
  consumeCurrentTurnFollowupTarget: () => TelegramAsyncFollowupTarget | undefined;
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

function getAsyncFollowupMessageType(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  if (Reflect.get(message, "role") !== "custom") return undefined;
  const customType = Reflect.get(message, "customType");
  return isNonEmptyString(customType) ? customType.trim() : undefined;
}

function isAsyncFollowupTurnMessage(message: unknown): boolean {
  const customType = getAsyncFollowupMessageType(message);
  return (
    customType === SUBAGENT_NOTIFY_CUSTOM_TYPE ||
    customType === SUBAGENT_CONTROL_NOTICE_CUSTOM_TYPE
  );
}

export function createTelegramAsyncFollowupRuntime(
  deps: TelegramAsyncFollowupRuntimeDeps,
): TelegramAsyncFollowupRuntime {
  const attributedRuns = new Map<string, TelegramAsyncAttributedRun>();
  const pendingFollowups: TelegramPendingAsyncFollowup[] = [];
  const deliveredStates = new Map<string, Set<TelegramAsyncFollowupKind>>();
  let currentTurnRunId: string | undefined;

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
    if (!deps.isCurrentOwner()) return;
    if (!attributedRuns.has(runId) || hasDeliveredKind(runId, kind)) return;
    if (hasPendingKind(pendingFollowups, runId, kind)) return;
    if (kind === "completion") {
      deletePendingEntry(pendingFollowups, runId, "needs_attention");
    }
    pendingFollowups.push({ runId, kind });
  }

  function getPendingEntry(runId: string | undefined): TelegramPendingAsyncFollowup | undefined {
    if (!runId) return undefined;
    return pendingFollowups.find((entry) => entry.runId === runId);
  }

  function getPendingTarget(runId: string | undefined): TelegramAsyncFollowupTarget | undefined {
    const pending = getPendingEntry(runId);
    if (!pending) return undefined;
    const attribution = attributedRuns.get(pending.runId);
    if (!attribution) return undefined;
    return {
      chatId: attribution.chatId,
      replyToMessageId: attribution.replyToMessageId,
    };
  }

  function getNextPendingRunId(): string | undefined {
    for (const next of pendingFollowups) {
      if (attributedRuns.has(next.runId)) return next.runId;
    }
    return undefined;
  }

  function consumeRunId(runId: string | undefined): TelegramAsyncFollowupTarget | undefined {
    const pending = getPendingEntry(runId);
    if (!pending) return undefined;
    const attribution = attributedRuns.get(pending.runId);
    if (!attribution) return undefined;
    deletePendingEntry(pendingFollowups, pending.runId, pending.kind);
    markDeliveredKind(pending.runId, pending.kind);
    if (pending.kind === "completion") {
      attributedRuns.delete(pending.runId);
      deliveredStates.delete(pending.runId);
    }
    return {
      chatId: attribution.chatId,
      replyToMessageId: attribution.replyToMessageId,
    };
  }

  return {
    clear: () => {
      attributedRuns.clear();
      pendingFollowups.splice(0, pendingFollowups.length);
      deliveredStates.clear();
      currentTurnRunId = undefined;
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
    handleMessageStart: (message) => {
      if (!deps.isCurrentOwner() || currentTurnRunId || !isAsyncFollowupTurnMessage(message)) {
        return;
      }
      currentTurnRunId = getNextPendingRunId();
    },
    hasCurrentTurnFollowupTarget: () => getPendingTarget(currentTurnRunId) !== undefined,
    clearCurrentTurn: () => {
      currentTurnRunId = undefined;
    },
    peekPendingFollowupTarget: () => getPendingTarget(getNextPendingRunId()),
    consumePendingFollowupTarget: () => consumeRunId(getNextPendingRunId()),
    consumeCurrentTurnFollowupTarget: () => {
      const target = consumeRunId(currentTurnRunId);
      currentTurnRunId = undefined;
      return target;
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
