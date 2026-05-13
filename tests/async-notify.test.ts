/**
 * Regression tests for Telegram async-run notifications
 * Exercises attribution, completion delivery, needs-attention delivery, and owner/session safety
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  bindTelegramAsyncNotificationEvents,
  buildTelegramAsyncCompletionNotice,
  buildTelegramAsyncNeedsAttentionNotice,
  createTelegramAsyncNotificationRuntime,
  createTelegramAsyncNotificationSessionHooks,
} from "../lib/async-notify.ts";
import {
  appendTelegramLifecycleHooks,
  prependTelegramLifecycleHooks,
} from "../lib/lifecycle.ts";
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

test("Async notify formats completion notices without markdown-only decoration", () => {
  const notice = buildTelegramAsyncCompletionNotice({
    id: "4b996ad0-10d8-414a-b114-a452bef9199c",
    agent: "reviewer",
    success: true,
    summary: "There is effectively no diff to review.",
  });
  assert.deepEqual(notice, {
    state: "completed",
    text:
      "Background task completed: reviewer [4b996ad0]\n\nThere is effectively no diff to review.",
  });
});

test("Async notify formats failed completion notices", () => {
  const notice = buildTelegramAsyncCompletionNotice({
    id: "run-123456789",
    agent: "worker",
    success: false,
    exitCode: 1,
    summary: "Validation failed.",
  });
  assert.deepEqual(notice, {
    state: "failed",
    text: "Background task failed: worker [run-1234]\n\nValidation failed.",
  });
});

test("Async notify formats paused completion notices from stable async result fields", () => {
  const stateNotice = buildTelegramAsyncCompletionNotice({
    id: "run-123456789",
    agent: "worker",
    success: false,
    state: "paused",
    summary: "Waiting for resume.",
  });
  const exitCodeNotice = buildTelegramAsyncCompletionNotice({
    id: "run-abcdefghi",
    agent: "worker",
    success: false,
    exitCode: 0,
    summary: "Waiting for resume.",
  });
  assert.deepEqual(stateNotice, {
    state: "paused",
    text: "Background task paused: worker [run-1234]\n\nWaiting for resume.",
  });
  assert.deepEqual(exitCodeNotice, {
    state: "paused",
    text: "Background task paused: worker [run-abcd]\n\nWaiting for resume.",
  });
});

test("Async notify formats async needs-attention notices from control events", () => {
  const notice = buildTelegramAsyncNeedsAttentionNotice({
    source: "async",
    event: {
      type: "needs_attention",
      runId: "run-123456789",
      agent: "worker",
      message: "worker needs attention after repeated mutating tool failures",
    },
  });
  assert.deepEqual(notice, {
    state: "needs_attention",
    runId: "run-123456789",
    text:
      "Background task needs attention: worker [run-1234]\n\nworker needs attention after repeated mutating tool failures",
  });
});

test("Async notify attributes Telegram-started runs and sends completion replies back to Telegram", async () => {
  const sent: Array<{ chatId: number; replyToMessageId: number | undefined; text: string }> = [];
  let activeTurn: PendingTelegramTurn | undefined = createAsyncNotifyTurn();
  const runtime = createTelegramAsyncNotificationRuntime({
    getActiveTurn: () => activeTurn,
    isCurrentOwner: () => true,
    sendTextReply: async (chatId, replyToMessageId, text) => {
      sent.push({ chatId, replyToMessageId, text });
    },
  });

  runtime.handleStarted({ id: "run-1" });
  activeTurn = undefined;
  await runtime.handleCompleted({
    id: "run-1",
    agent: "reviewer",
    success: true,
    summary: "No actionable findings.",
  });

  assert.deepEqual(sent, [
    {
      chatId: 7,
      replyToMessageId: 11,
      text: "Background task completed: reviewer [run-1]\n\nNo actionable findings.",
    },
  ]);
  assert.equal(runtime.getAttribution("run-1"), undefined);
});

test("Async notify sends failed and paused completion replies back to Telegram", async () => {
  const sent: string[] = [];
  let activeTurn: PendingTelegramTurn | undefined = createAsyncNotifyTurn();
  const runtime = createTelegramAsyncNotificationRuntime({
    getActiveTurn: () => activeTurn,
    isCurrentOwner: () => true,
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      sent.push(text);
    },
  });

  runtime.handleStarted({ id: "run-failed" });
  activeTurn = undefined;
  await runtime.handleCompleted({
    id: "run-failed",
    agent: "reviewer",
    success: false,
    exitCode: 1,
    summary: "Validation failed.",
  });

  activeTurn = createAsyncNotifyTurn();
  runtime.handleStarted({ id: "run-paused" });
  activeTurn = undefined;
  await runtime.handleCompleted({
    id: "run-paused",
    agent: "reviewer",
    success: false,
    state: "paused",
    summary: "Waiting for resume.",
  });

  assert.deepEqual(sent, [
    "Background task failed: reviewer [run-fail]\n\nValidation failed.",
    "Background task paused: reviewer [run-paus]\n\nWaiting for resume.",
  ]);
});

test("Async notify ignores runs that were not started from an active Telegram turn", async () => {
  const sent: unknown[] = [];
  const runtime = createTelegramAsyncNotificationRuntime({
    getActiveTurn: () => undefined,
    isCurrentOwner: () => true,
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      sent.push(text);
    },
  });

  runtime.handleStarted({ id: "run-1" });
  await runtime.handleCompleted({
    id: "run-1",
    agent: "reviewer",
    success: true,
    summary: "Done.",
  });

  assert.deepEqual(sent, []);
});

test("Async notify ignores guest Telegram turns for async attribution", async () => {
  const sent: string[] = [];
  const runtime = createTelegramAsyncNotificationRuntime({
    getActiveTurn: () => createAsyncNotifyTurn({ guestQueryId: "guest-1" }),
    isCurrentOwner: () => true,
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      sent.push(text);
    },
  });

  runtime.handleStarted({ id: "run-1" });
  await runtime.handleCompleted({
    id: "run-1",
    agent: "reviewer",
    success: true,
    summary: "Done.",
  });

  assert.deepEqual(sent, []);
});

test("Async notify sends one async needs-attention notice per attributed run and keeps completion delivery", async () => {
  const sent: string[] = [];
  let activeTurn: PendingTelegramTurn | undefined = createAsyncNotifyTurn();
  const runtime = createTelegramAsyncNotificationRuntime({
    getActiveTurn: () => activeTurn,
    isCurrentOwner: () => true,
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      sent.push(text);
    },
  });

  runtime.handleStarted({ id: "run-1" });
  activeTurn = undefined;
  await runtime.handleControl({
    source: "async",
    event: {
      type: "needs_attention",
      runId: "run-1",
      agent: "reviewer",
      message: "reviewer needs attention",
    },
  });
  await runtime.handleControl({
    source: "async",
    event: {
      type: "needs_attention",
      runId: "run-1",
      agent: "reviewer",
      message: "reviewer needs attention",
    },
  });
  await runtime.handleCompleted({
    id: "run-1",
    agent: "reviewer",
    success: true,
    summary: "Finished after intervention.",
  });

  assert.deepEqual(sent, [
    "Background task needs attention: reviewer [run-1]\n\nreviewer needs attention",
    "Background task completed: reviewer [run-1]\n\nFinished after intervention.",
  ]);
});

test("Async notify suppresses delivery when the current bridge no longer owns Telegram", async () => {
  const sent: string[] = [];
  let activeTurn: PendingTelegramTurn | undefined = createAsyncNotifyTurn();
  const runtime = createTelegramAsyncNotificationRuntime({
    getActiveTurn: () => activeTurn,
    isCurrentOwner: () => false,
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      sent.push(text);
    },
  });

  runtime.handleStarted({ id: "run-1" });
  activeTurn = undefined;
  await runtime.handleCompleted({
    id: "run-1",
    agent: "reviewer",
    success: true,
    summary: "Done.",
  });

  assert.deepEqual(sent, []);
  assert.equal(runtime.getAttribution("run-1"), undefined);
});

test("Async notify clear drops attributed runs across session replacement", async () => {
  const sent: string[] = [];
  const runtime = createTelegramAsyncNotificationRuntime({
    getActiveTurn: () => createAsyncNotifyTurn(),
    isCurrentOwner: () => true,
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      sent.push(text);
    },
  });

  runtime.handleStarted({ id: "run-1" });
  runtime.clear();
  await runtime.handleCompleted({
    id: "run-1",
    agent: "reviewer",
    success: true,
    summary: "Done.",
  });

  assert.deepEqual(sent, []);
});

test("Async notify clears attribution before session start and shutdown in the entrypoint lifecycle composition", async () => {
  const events: string[] = [];
  let activeTurn: PendingTelegramTurn | undefined = createAsyncNotifyTurn();
  const sent: string[] = [];
  const runtime = createTelegramAsyncNotificationRuntime({
    getActiveTurn: () => activeTurn,
    isCurrentOwner: () => true,
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      sent.push(text);
    },
  });

  const sessionLifecycle = appendTelegramLifecycleHooks(
    prependTelegramLifecycleHooks(
      createTelegramAsyncNotificationSessionHooks({
        clear: () => {
          events.push("clear");
          runtime.clear();
        },
      }),
      {
        onSessionStart: async () => {
          events.push("queue-start");
        },
        onSessionShutdown: async () => {
          events.push("queue-shutdown");
        },
      },
    ),
    {
      onSessionStart: async () => {
        events.push("poll-start");
      },
    },
  );

  runtime.handleStarted({ id: "run-start" });
  activeTurn = undefined;
  await sessionLifecycle.onSessionStart({} as never, {} as never);
  await runtime.handleCompleted({
    id: "run-start",
    agent: "reviewer",
    success: true,
    summary: "Done.",
  });

  activeTurn = createAsyncNotifyTurn();
  runtime.handleStarted({ id: "run-shutdown" });
  activeTurn = undefined;
  await sessionLifecycle.onSessionShutdown({} as never, {} as never);
  await runtime.handleCompleted({
    id: "run-shutdown",
    agent: "reviewer",
    success: true,
    summary: "Done.",
  });

  assert.deepEqual(events, [
    "clear",
    "queue-start",
    "poll-start",
    "clear",
    "queue-shutdown",
  ]);
  assert.deepEqual(sent, []);
});

test("Async notify records runtime events when Telegram delivery fails", async () => {
  const recorded: Array<{ category: string; details?: Record<string, unknown> }> = [];
  let activeTurn: PendingTelegramTurn | undefined = createAsyncNotifyTurn();
  const runtime = createTelegramAsyncNotificationRuntime({
    getActiveTurn: () => activeTurn,
    isCurrentOwner: () => true,
    sendTextReply: async () => {
      throw new Error("send failed");
    },
    recordRuntimeEvent: (category, _error, details) => {
      recorded.push({ category, details });
    },
  });

  runtime.handleStarted({ id: "run-1" });
  activeTurn = undefined;
  await runtime.handleCompleted({
    id: "run-1",
    agent: "reviewer",
    success: false,
    exitCode: 1,
    summary: "Validation failed.",
  });

  assert.deepEqual(recorded, [
    {
      category: "async-notify",
      details: {
        runId: "run-1",
        state: "failed",
        chatId: 7,
        replyToMessageId: 11,
      },
    },
  ]);
});

test("Async notify binds pi-subagents event-bus channels to runtime handlers", () => {
  const seen: string[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const runtime = {
    handleStarted(payload: unknown) {
      seen.push(`started:${JSON.stringify(payload)}`);
    },
    async handleCompleted(payload: unknown) {
      seen.push(`completed:${JSON.stringify(payload)}`);
    },
    async handleControl(payload: unknown) {
      seen.push(`control:${JSON.stringify(payload)}`);
    },
  };

  const unsubscribes = bindTelegramAsyncNotificationEvents(
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

  bindTelegramAsyncNotificationEvents(eventBus, {
    handleStarted() {},
    async handleCompleted() {},
    async handleControl() {},
  });
  bindTelegramAsyncNotificationEvents(eventBus, {
    handleStarted() {},
    async handleCompleted() {},
    async handleControl() {},
  });

  assert.equal(unsubscribed, 3);
  assert.equal(listeners.size, 3);
});
