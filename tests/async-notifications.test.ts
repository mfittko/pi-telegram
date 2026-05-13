/**
 * Regression tests for Telegram async run notification runtime
 * Covers attribution store, deduplication, notification delivery, and prompt attribution hooks
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramAsyncRunNotificationText,
  createTelegramAsyncRunAttributionStore,
  createTelegramAsyncRunNotificationHandler,
  createTelegramAsyncRunSessionLifecycleHooks,
  getTelegramAsyncRunNotificationState,
  type TelegramAsyncRunNotificationState,
} from "../lib/async-notifications.ts";
import {
  createTelegramProactiveBeforeAgentStartHook,
  createTelegramBeforeAgentStartHook,
} from "../lib/prompts.ts";
import {
  createTelegramAgentEndHook,
  handleTelegramAgentEndRuntime,
} from "../lib/queue.ts";
import type { PendingTelegramTurn } from "../lib/queue.ts";

type BeforeAgentStartEvent = Parameters<
  ReturnType<typeof createTelegramBeforeAgentStartHook>
>[0];

function createBeforeAgentStartEvent(
  prompt: string,
  systemPrompt = "base",
): BeforeAgentStartEvent {
  return { prompt, systemPrompt } as BeforeAgentStartEvent;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createTestPromptTurn(
  overrides: Partial<PendingTelegramTurn> = {},
): PendingTelegramTurn {
  return {
    kind: "prompt",
    chatId: 1,
    replyToMessageId: 2,
    sourceMessageIds: [2],
    queueOrder: 1,
    queueLane: "default",
    laneOrder: 1,
    queuedAttachments: [],
    content: [{ type: "text", text: "prompt" }],
    historyText: "prompt",
    statusSummary: "prompt",
    ...overrides,
  };
}

// --- Attribution Store ---

test("Attribution store assigns unique run tokens and tracks attribution", () => {
  const store = createTelegramAsyncRunAttributionStore();
  assert.equal(store.getAttribution(), undefined);
  const token1 = store.beginRun(7);
  assert.deepEqual(store.getAttribution(), { chatId: 7, runToken: token1 });
  const token2 = store.beginRun(42);
  assert.notEqual(token1, token2);
  assert.deepEqual(store.getAttribution(), { chatId: 42, runToken: token2 });
  store.clearAttribution();
  assert.equal(store.getAttribution(), undefined);
});

test("Attribution store tracks notification deduplication per run token", () => {
  const store = createTelegramAsyncRunAttributionStore();
  const token = store.beginRun(7);
  assert.equal(store.hasNotified(token), false);
  store.markNotified(token);
  assert.equal(store.hasNotified(token), true);
  const token2 = store.beginRun(7);
  assert.equal(store.hasNotified(token2), false);
});

test("Attribution store resetDedup clears notification history", () => {
  const store = createTelegramAsyncRunAttributionStore();
  const token = store.beginRun(7);
  store.markNotified(token);
  assert.equal(store.hasNotified(token), true);
  store.resetDedup();
  assert.equal(store.hasNotified(token), false);
});

// --- Notification State Mapping ---

test("Async run notification state maps Pi stop reasons to notification states", () => {
  assert.equal(
    getTelegramAsyncRunNotificationState("error"),
    "failure" satisfies TelegramAsyncRunNotificationState,
  );
  assert.equal(
    getTelegramAsyncRunNotificationState("length"),
    "needs_attention" satisfies TelegramAsyncRunNotificationState,
  );
  assert.equal(getTelegramAsyncRunNotificationState("stop"), undefined);
  assert.equal(getTelegramAsyncRunNotificationState("aborted"), undefined);
  assert.equal(getTelegramAsyncRunNotificationState("toolUse"), undefined);
  assert.equal(getTelegramAsyncRunNotificationState(undefined), undefined);
});

test("Async run notification text is concise and phone-friendly", () => {
  const failureText = buildTelegramAsyncRunNotificationText("failure");
  const needsAttentionText =
    buildTelegramAsyncRunNotificationText("needs_attention");
  assert.ok(failureText.length < 80, "failure message should be concise");
  assert.ok(
    needsAttentionText.length < 120,
    "needs_attention message should be concise",
  );
  assert.match(failureText, /failed/i);
  assert.match(needsAttentionText, /attention|limit/i);
});

// --- Notification Handler ---

test("Async notification handler sends failure notification for attributed run", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const events: string[] = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async (chatId, replyToMessageId, text) => {
      events.push(`reply:${chatId}:${replyToMessageId}:${text}`);
    },
  });
  store.beginRun(9);
  handler("error");
  await flushMicrotasks();
  const failureText = buildTelegramAsyncRunNotificationText("failure");
  assert.deepEqual(events, [`reply:9:undefined:${failureText}`]);
  // Deduplication state should be marked after delivery
  const attribution = store.getAttribution();
  assert.ok(
    attribution && store.hasNotified(attribution.runToken),
    "markNotified should have been called after delivery",
  );
});

test("Async notification handler sends needs_attention notification for attributed run", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const events: string[] = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async (chatId, replyToMessageId, text) => {
      events.push(`reply:${chatId}:${replyToMessageId}:${text}`);
    },
  });
  store.beginRun(9);
  handler("length");
  await flushMicrotasks();
  const needsAttentionText =
    buildTelegramAsyncRunNotificationText("needs_attention");
  assert.deepEqual(events, [`reply:9:undefined:${needsAttentionText}`]);
  // Deduplication state should be marked after delivery
  const attribution = store.getAttribution();
  assert.ok(
    attribution && store.hasNotified(attribution.runToken),
    "markNotified should have been called after delivery",
  );
});

test("Async notification handler stays silent for success and aborted stop reasons", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const events: string[] = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async (chatId, _replyTo, text) => {
      events.push(`reply:${chatId}:${text}`);
    },
  });
  store.beginRun(9);
  handler("stop");
  handler("aborted");
  handler(undefined);
  await flushMicrotasks();
  assert.deepEqual(events, []);
});

test("Async notification handler stays silent when proactive push is disabled", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const events: string[] = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => false,
    sendMarkdownReply: async (_chatId, _replyTo, text) => {
      events.push(text);
    },
  });
  store.beginRun(9);
  handler("error");
  await flushMicrotasks();
  assert.deepEqual(events, []);
});

test("Async notification handler stays silent for runs without attribution", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const events: string[] = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async (_chatId, _replyTo, text) => {
      events.push(text);
    },
  });
  // No beginRun called — no attribution
  handler("error");
  await flushMicrotasks();
  assert.deepEqual(events, []);
});

test("Async notification handler deduplicates notifications for the same run token", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const events: string[] = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async (_chatId, _replyTo, text) => {
      events.push(text);
    },
  });
  store.beginRun(9);
  handler("error");
  handler("error");
  await flushMicrotasks();
  assert.equal(events.length, 1, "should only send once for same run token");
});

test("Async notification handler records delivery failures in runtime events", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const runtimeEvents: Array<{ category: string; details: unknown }> = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async () => {
      throw new Error("send failed");
    },
    recordRuntimeEvent: (category, _error, details) => {
      runtimeEvents.push({ category, details });
    },
  });
  store.beginRun(5);
  handler("error");
  await flushMicrotasks();
  assert.equal(runtimeEvents.length, 1);
  assert.equal(runtimeEvents[0]?.category, "async-notification");
  assert.deepEqual(runtimeEvents[0]?.details, { chatId: 5, state: "failure" });
});

test("Async notification handler does not await Telegram delivery inline", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  let deliveryStarted = false;
  let resolveDelivery: (() => void) | undefined;
  const delivery = new Promise<void>((resolve) => {
    resolveDelivery = resolve;
  });
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async () => {
      deliveryStarted = true;
      await delivery;
    },
  });
  store.beginRun(11);
  handler("error");
  assert.equal(deliveryStarted, false);
  await flushMicrotasks();
  assert.equal(deliveryStarted, true);
  resolveDelivery?.();
  await flushMicrotasks();
});

// --- Session Lifecycle Hooks ---

test("Async run session lifecycle hooks reset attribution and dedup state", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const hooks = createTelegramAsyncRunSessionLifecycleHooks(store);
  store.beginRun(7);
  store.markNotified("1");
  assert.ok(store.getAttribution() !== undefined);
  assert.equal(store.hasNotified("1"), true);
  await hooks.onSessionShutdown();
  assert.equal(store.getAttribution(), undefined);
  assert.equal(store.hasNotified("1"), false);
  store.beginRun(7);
  store.markNotified("2");
  await hooks.onSessionStart();
  assert.equal(store.getAttribution(), undefined);
  assert.equal(store.hasNotified("2"), false);
});

// --- Prompt Attribution Hook ---

test("Proactive before-agent-start hook registers attribution for Telegram-prefixed prompts", async () => {
  const events: number[] = [];
  const hook = createTelegramProactiveBeforeAgentStartHook({
    isProactivePushEnabled: () => true,
    isCurrentOwner: () => true,
    onAttributedRunStart: (chatId) => {
      events.push(chatId);
    },
    getDefaultChatId: () => 42,
  });
  await hook(createBeforeAgentStartEvent("[telegram] hello"), "ctx");
  assert.deepEqual(events, [42]);
});

test("Proactive before-agent-start hook skips attribution for local prompts", async () => {
  const events: number[] = [];
  const hook = createTelegramProactiveBeforeAgentStartHook({
    isProactivePushEnabled: () => true,
    isCurrentOwner: () => true,
    onAttributedRunStart: (chatId) => {
      events.push(chatId);
    },
    getDefaultChatId: () => 42,
  });
  await hook(createBeforeAgentStartEvent("local prompt"), "ctx");
  assert.deepEqual(events, []);
});

test("Proactive before-agent-start hook skips attribution when proactive push is disabled", async () => {
  const events: number[] = [];
  const hook = createTelegramProactiveBeforeAgentStartHook({
    isProactivePushEnabled: () => false,
    isCurrentOwner: () => true,
    onAttributedRunStart: (chatId) => {
      events.push(chatId);
    },
    getDefaultChatId: () => 42,
  });
  await hook(createBeforeAgentStartEvent("[telegram] hello"), "ctx");
  assert.deepEqual(events, []);
});

test("Proactive before-agent-start hook skips attribution when not current owner", async () => {
  const events: number[] = [];
  const hook = createTelegramProactiveBeforeAgentStartHook({
    isProactivePushEnabled: () => true,
    isCurrentOwner: () => false,
    onAttributedRunStart: (chatId) => {
      events.push(chatId);
    },
    getDefaultChatId: () => 42,
  });
  await hook(createBeforeAgentStartEvent("[telegram] hello"), "ctx");
  assert.deepEqual(events, []);
});

test("Proactive before-agent-start hook skips attribution when no default chat ID", async () => {
  const events: number[] = [];
  const hook = createTelegramProactiveBeforeAgentStartHook({
    isProactivePushEnabled: () => true,
    isCurrentOwner: () => true,
    onAttributedRunStart: (chatId) => {
      events.push(chatId);
    },
    getDefaultChatId: () => undefined,
  });
  await hook(createBeforeAgentStartEvent("[telegram] hello"), "ctx");
  assert.deepEqual(events, []);
});

// --- Integration: agent_end runtime with async notifications ---

test("Agent end runtime calls async notification handler for attributed failure runs", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const events: string[] = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async (chatId, _replyTo, text) => {
      events.push(`notify:${chatId}:${text}`);
    },
  });
  store.beginRun(9);
  await handleTelegramAgentEndRuntime({
    turn: undefined,
    assistant: { stopReason: "error", errorMessage: "something broke" },
    preserveQueuedTurnsAsHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    notifyAsyncRunCompletion: handler,
  });
  await flushMicrotasks();
  const failureText = buildTelegramAsyncRunNotificationText("failure");
  assert.deepEqual(events, [`notify:9:${failureText}`]);
});

test("Agent end runtime calls async notification handler for attributed needs-attention runs", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const events: string[] = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async (chatId, _replyTo, text) => {
      events.push(`notify:${chatId}:${text}`);
    },
  });
  store.beginRun(9);
  await handleTelegramAgentEndRuntime({
    turn: undefined,
    assistant: { stopReason: "length" },
    preserveQueuedTurnsAsHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    notifyAsyncRunCompletion: handler,
  });
  await flushMicrotasks();
  const needsAttentionText =
    buildTelegramAsyncRunNotificationText("needs_attention");
  assert.deepEqual(events, [`notify:9:${needsAttentionText}`]);
});

test("Agent end runtime does not call async notification handler when there is an active turn", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const events: string[] = [];
  const handler = createTelegramAsyncRunNotificationHandler({
    getAttribution: store.getAttribution,
    hasNotified: store.hasNotified,
    markNotified: store.markNotified,
    isProactivePushEnabled: () => true,
    sendMarkdownReply: async (_chatId, _replyTo, text) => {
      events.push(text);
    },
  });
  store.beginRun(9);
  const turn = createTestPromptTurn();
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { stopReason: "error", errorMessage: "something broke" },
    preserveQueuedTurnsAsHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    notifyAsyncRunCompletion: handler,
  });
  await flushMicrotasks();
  // The notification handler is not called for the !turn case when turn exists
  assert.deepEqual(events, []);
});

test("Agent end hook clears async run attribution only after a no-turn completion", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  let notificationCalls = 0;
  const hook = createTelegramAgentEndHook({
    getActiveTurn: () => undefined,
    extractAssistant: () => ({ stopReason: "error" }),
    getPreserveQueuedTurnsAsHistory: () => false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    requestDeferredDispatchNextQueuedTelegramTurn: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    notifyAsyncRunCompletion: () => {
      notificationCalls += 1;
    },
    clearAsyncRunAttribution: store.clearAttribution,
  });
  store.beginRun(9);
  await hook({ messages: [] }, "ctx" as never);
  assert.equal(notificationCalls, 1);
  assert.equal(store.getAttribution(), undefined);
});

test("Agent end hook preserves async run attribution across attributed foreground turn completion", async () => {
  const store = createTelegramAsyncRunAttributionStore();
  const turn = createTestPromptTurn();
  const hook = createTelegramAgentEndHook({
    getActiveTurn: () => turn,
    extractAssistant: () => ({ text: "done" }),
    getPreserveQueuedTurnsAsHistory: () => false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    requestDeferredDispatchNextQueuedTelegramTurn: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    clearAsyncRunAttribution: store.clearAttribution,
  });
  const token = store.beginRun(9);
  await hook({ messages: [] }, "ctx" as never);
  assert.deepEqual(store.getAttribution(), { chatId: 9, runToken: token });
});
