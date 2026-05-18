/**
 * Regression tests for Telegram async attribution and pending follow-up helpers
 * Exercises attribution, pending follow-up queuing, session clearing, and event-bus binding
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  bindTelegramAsyncFollowupEvents,
  createTelegramAsyncFollowupRuntime,
  createTelegramAsyncFollowupSessionHooks,
} from "../lib/async-notify.ts";
import type { PendingTelegramTurn } from "../lib/queue.ts";

function createAsyncNotifyTurn(
  overrides: Partial<PendingTelegramTurn> = {},
): PendingTelegramTurn {
  return {
    kind: "prompt",
    chatId: 7,
    replyToMessageId: 11,
    sourceMessageIds: [11],
    queueOrder: 1,
    queueLane: "default",
    laneOrder: 1,
    queuedAttachments: [],
    content: [{ type: "text", text: "review this" }],
    historyText: "review this",
    statusSummary: "review",
    ...overrides,
  };
}

test("Async notify queues pending completion follow-ups for attributed runs", () => {
  let activeTurn: PendingTelegramTurn | undefined = createAsyncNotifyTurn();
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => activeTurn,
    isCurrentOwner: () => true,
  });
  runtime.handleStarted({ id: "run-1" });
  activeTurn = undefined;
  runtime.handleCompleted({ id: "run-1" });
  assert.deepEqual(runtime.peekPendingFollowupTarget(), {
    chatId: 7,
    replyToMessageId: 11,
  });
  assert.deepEqual(runtime.consumePendingFollowupTarget(), {
    chatId: 7,
    replyToMessageId: 11,
  });
});

test("Async notify queues pending needs-attention follow-ups for attributed runs", () => {
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => createAsyncNotifyTurn(),
    isCurrentOwner: () => true,
  });
  runtime.handleStarted({ id: "run-1" });
  runtime.handleControl({
    source: "async",
    event: { type: "needs_attention", runId: "run-1" },
  });
  assert.deepEqual(runtime.peekPendingFollowupTarget(), {
    chatId: 7,
    replyToMessageId: 11,
  });
});

test("Async notify only binds a pending follow-up to the current turn after the matching subagent custom message starts", () => {
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => createAsyncNotifyTurn(),
    isCurrentOwner: () => true,
  });
  runtime.handleStarted({ id: "run-1" });
  runtime.handleCompleted({ id: "run-1" });

  runtime.handleMessageStart({ role: "user", content: [{ type: "text", text: "unrelated" }] });
  assert.equal(runtime.hasCurrentTurnFollowupTarget(), false);

  runtime.handleMessageStart({
    role: "custom",
    customType: "subagent-notify",
    content: "Background task completed",
  });
  assert.equal(runtime.hasCurrentTurnFollowupTarget(), true);
  assert.deepEqual(runtime.consumeCurrentTurnFollowupTarget(), {
    chatId: 7,
    replyToMessageId: 11,
  });
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);
});


test("Async notify ignores unrelated custom messages while a pending follow-up waits", () => {
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => createAsyncNotifyTurn(),
    isCurrentOwner: () => true,
  });
  runtime.handleStarted({ id: "run-1" });
  runtime.handleCompleted({ id: "run-1" });
  runtime.handleMessageStart({
    role: "custom",
    customType: "other-extension-message",
    content: "hello",
  });
  assert.equal(runtime.hasCurrentTurnFollowupTarget(), false);
  assert.deepEqual(runtime.peekPendingFollowupTarget(), {
    chatId: 7,
    replyToMessageId: 11,
  });
});

test("Async notify ignores runs that were not started from an active Telegram turn", () => {
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => undefined,
    isCurrentOwner: () => true,
  });
  runtime.handleStarted({ id: "run-1" });
  runtime.handleCompleted({ id: "run-1" });
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);
});

test("Async notify ignores guest Telegram turns for attribution", () => {
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => createAsyncNotifyTurn({ guestQueryId: "guest-1" }),
    isCurrentOwner: () => true,
  });
  runtime.handleStarted({ id: "run-1" });
  runtime.handleCompleted({ id: "run-1" });
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);
});

test("Async notify suppresses attribution when the current bridge no longer owns Telegram", () => {
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => createAsyncNotifyTurn(),
    isCurrentOwner: () => false,
  });
  runtime.handleStarted({ id: "run-1" });
  runtime.handleCompleted({ id: "run-1" });
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);
});

test("Async notify does not queue pending follow-ups after owner loss", () => {
  let isOwner = true;
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => createAsyncNotifyTurn(),
    isCurrentOwner: () => isOwner,
  });
  runtime.handleStarted({ id: "run-1" });
  isOwner = false;
  runtime.handleControl({
    source: "async",
    event: { type: "needs_attention", runId: "run-1" },
  });
  runtime.handleCompleted({ id: "run-1" });
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);
});

test("Async notify deduplicates pending follow-ups and prefers completion over stale pending attention", () => {
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => createAsyncNotifyTurn(),
    isCurrentOwner: () => true,
  });
  runtime.handleStarted({ id: "run-1" });
  runtime.handleControl({
    source: "async",
    event: { type: "needs_attention", runId: "run-1" },
  });
  runtime.handleControl({
    source: "async",
    event: { type: "needs_attention", runId: "run-1" },
  });
  runtime.handleCompleted({ id: "run-1" });
  runtime.handleCompleted({ id: "run-1" });
  assert.deepEqual(runtime.consumePendingFollowupTarget(), {
    chatId: 7,
    replyToMessageId: 11,
  });
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);
});

test("Async notify can surface attention and later completion as separate follow-ups when consumed in order", () => {
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => createAsyncNotifyTurn(),
    isCurrentOwner: () => true,
  });
  runtime.handleStarted({ id: "run-1" });
  runtime.handleControl({
    source: "async",
    event: { type: "needs_attention", runId: "run-1" },
  });
  assert.deepEqual(runtime.consumePendingFollowupTarget(), {
    chatId: 7,
    replyToMessageId: 11,
  });
  runtime.handleCompleted({ id: "run-1" });
  assert.deepEqual(runtime.consumePendingFollowupTarget(), {
    chatId: 7,
    replyToMessageId: 11,
  });
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);
});

test("Async notify clear drops attributed and pending runs across session replacement", async () => {
  const runtime = createTelegramAsyncFollowupRuntime({
    getActiveTurn: () => createAsyncNotifyTurn(),
    isCurrentOwner: () => true,
  });
  runtime.handleStarted({ id: "run-1" });
  runtime.handleCompleted({ id: "run-1" });
  runtime.clear();
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);

  const hooks = createTelegramAsyncFollowupSessionHooks({
    clear: runtime.clear,
  });
  runtime.handleStarted({ id: "run-2" });
  runtime.handleCompleted({ id: "run-2" });
  await hooks.onSessionStart({} as never, {} as never);
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);
  runtime.handleStarted({ id: "run-3" });
  runtime.handleCompleted({ id: "run-3" });
  await hooks.onSessionShutdown({} as never, {} as never);
  assert.equal(runtime.peekPendingFollowupTarget(), undefined);
});

test("Async notify binds pi-subagents event-bus channels to runtime handlers", () => {
  const seen: string[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const runtime = {
    handleStarted(payload: unknown) {
      seen.push(`started:${JSON.stringify(payload)}`);
    },
    handleCompleted(payload: unknown) {
      seen.push(`completed:${JSON.stringify(payload)}`);
    },
    handleControl(payload: unknown) {
      seen.push(`control:${JSON.stringify(payload)}`);
    },
    peekPendingFollowupTarget() {
      return undefined;
    },
    consumePendingFollowupTarget() {
      return undefined;
    },
    clear() {},
  };

  const unsubscribes = bindTelegramAsyncFollowupEvents(
    {
      on(event, handler) {
        listeners.set(event, handler);
        return () => {
          listeners.delete(event);
        };
      },
    },
    runtime,
  );

  listeners.get("subagent:async-started")?.({ id: "a" });
  listeners.get("subagent:async-complete")?.({ id: "b" });
  listeners.get("subagent:control-event")?.({
    source: "async",
    event: { type: "needs_attention", runId: "c" },
  });

  assert.deepEqual(seen, [
    'started:{"id":"a"}',
    'completed:{"id":"b"}',
    'control:{"source":"async","event":{"type":"needs_attention","runId":"c"}}',
  ]);
  for (const unsubscribe of unsubscribes) unsubscribe();
  assert.equal(listeners.size, 0);
});

test("Async notify removes stale event listeners before rebinding", () => {
  const listeners = new Map<string, (payload: unknown) => void>();
  let unsubscribed = 0;
  const eventBus = {
    on(event: string, handler: (payload: unknown) => void) {
      listeners.set(event, handler);
      return () => {
        unsubscribed += 1;
        listeners.delete(event);
      };
    },
  };

  bindTelegramAsyncFollowupEvents(eventBus, {
    handleStarted() {},
    handleCompleted() {},
    handleControl() {},
  });
  bindTelegramAsyncFollowupEvents(eventBus, {
    handleStarted() {},
    handleCompleted() {},
    handleControl() {},
  });

  assert.equal(unsubscribed, 3);
  assert.equal(listeners.size, 3);
});

test("Async notify keeps listeners for distinct event buses isolated", () => {
  let firstBusUnsubscribed = 0;
  let secondBusUnsubscribed = 0;
  const firstBusListeners = new Map<string, (payload: unknown) => void>();
  const secondBusListeners = new Map<string, (payload: unknown) => void>();
  const firstBus = {
    on(event: string, handler: (payload: unknown) => void) {
      firstBusListeners.set(event, handler);
      return () => {
        firstBusUnsubscribed += 1;
        firstBusListeners.delete(event);
      };
    },
  };
  const secondBus = {
    on(event: string, handler: (payload: unknown) => void) {
      secondBusListeners.set(event, handler);
      return () => {
        secondBusUnsubscribed += 1;
        secondBusListeners.delete(event);
      };
    },
  };

  bindTelegramAsyncFollowupEvents(firstBus, {
    handleStarted() {},
    handleCompleted() {},
    handleControl() {},
  });
  bindTelegramAsyncFollowupEvents(secondBus, {
    handleStarted() {},
    handleCompleted() {},
    handleControl() {},
  });

  assert.equal(firstBusUnsubscribed, 0);
  assert.equal(secondBusUnsubscribed, 0);
  assert.equal(firstBusListeners.size, 3);
  assert.equal(secondBusListeners.size, 3);
});
