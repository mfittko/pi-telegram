/**
 * Telegram async run notification runtime
 * Zones: pi agent lifecycle, telegram session, proactive push
 * Owns attribution tracking, deduplication, and notification delivery for Pi runs
 * attributed to the Telegram session that complete without an active Telegram turn
 */

/** Completion states that trigger an async run notification */
export type TelegramAsyncRunNotificationState = "failure" | "needs_attention";

export interface TelegramAsyncRunAttribution {
  chatId: number;
  runToken: string;
}

export interface TelegramAsyncRunAttributionStore {
  /** Begin a new attributed run tied to this chatId, returns the unique run token */
  beginRun: (chatId: number) => string;
  /** Get the current run attribution, or undefined if none is active */
  getAttribution: () => TelegramAsyncRunAttribution | undefined;
  /** Clear the current attribution (called on agent_end or session shutdown) */
  clearAttribution: () => void;
  /** Returns true if a notification has already been sent for this run token */
  hasNotified: (runToken: string) => boolean;
  /** Record that a notification was sent for this run token */
  markNotified: (runToken: string) => void;
  /** Reset deduplication state (called on session start or shutdown) */
  resetDedup: () => void;
}

export function createTelegramAsyncRunAttributionStore(): TelegramAsyncRunAttributionStore {
  let currentAttribution: TelegramAsyncRunAttribution | undefined;
  let nextToken = 0;
  const notifiedTokens = new Set<string>();
  return {
    beginRun: (chatId) => {
      const runToken = String(++nextToken);
      currentAttribution = { chatId, runToken };
      return runToken;
    },
    getAttribution: () => currentAttribution,
    clearAttribution: () => {
      currentAttribution = undefined;
    },
    hasNotified: (runToken) => notifiedTokens.has(runToken),
    markNotified: (runToken) => {
      notifiedTokens.add(runToken);
    },
    resetDedup: () => {
      notifiedTokens.clear();
    },
  };
}

export function buildTelegramAsyncRunNotificationText(
  state: TelegramAsyncRunNotificationState,
): string {
  if (state === "failure") {
    return "⚠️ Background Pi run failed.";
  }
  return "⏸ Background Pi run needs attention — context limit reached.";
}

export function getTelegramAsyncRunNotificationState(
  stopReason: string | undefined,
): TelegramAsyncRunNotificationState | undefined {
  if (stopReason === "error") return "failure";
  if (stopReason === "length") return "needs_attention";
  return undefined;
}

export interface TelegramAsyncRunNotificationHandlerDeps {
  getAttribution: () => TelegramAsyncRunAttribution | undefined;
  hasNotified: (runToken: string) => boolean;
  markNotified: (runToken: string) => void;
  isProactivePushEnabled: () => boolean;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
  ) => Promise<unknown>;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export function createTelegramAsyncRunNotificationHandler(
  deps: TelegramAsyncRunNotificationHandlerDeps,
): (stopReason: string | undefined) => Promise<void> {
  return async function handleAsyncRunCompletion(stopReason) {
    if (!deps.isProactivePushEnabled()) return;
    const state = getTelegramAsyncRunNotificationState(stopReason);
    if (!state) return;
    const attribution = deps.getAttribution();
    if (!attribution) return;
    if (deps.hasNotified(attribution.runToken)) return;
    deps.markNotified(attribution.runToken);
    const text = buildTelegramAsyncRunNotificationText(state);
    try {
      await deps.sendMarkdownReply(attribution.chatId, undefined, text);
    } catch (error) {
      deps.recordRuntimeEvent?.("async-notification", error, {
        chatId: attribution.chatId,
        state,
      });
    }
  };
}

export function createTelegramAsyncRunSessionLifecycleHooks(
  store: Pick<
    TelegramAsyncRunAttributionStore,
    "clearAttribution" | "resetDedup"
  >,
): {
  onSessionStart: () => Promise<void>;
  onSessionShutdown: () => Promise<void>;
} {
  async function onSessionStart() {
    store.resetDedup();
    store.clearAttribution();
  }
  async function onSessionShutdown() {
    store.clearAttribution();
    store.resetDedup();
  }
  return { onSessionStart, onSessionShutdown };
}
