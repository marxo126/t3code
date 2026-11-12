import type { AssistantCitation, MessageId } from "@t3tools/contracts";

export type ThreadMessageJumpQuote = Pick<AssistantCitation, "text" | "occurrence">;

// A palette message result opens its thread at that message. The thread
// screen reads the request while it shows that thread, and finishes it once
// the feed is there or the message cannot be found. A request whose thread
// never showed lapses, so a later plain open does not jump, as on web.
const PENDING_JUMP_MS = 30_000;
let pending: {
  readonly threadKey: string;
  readonly messageId: MessageId;
  readonly quote: ThreadMessageJumpQuote | null;
  readonly at: number;
} | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function requestThreadMessageJump(
  threadKey: string,
  messageId: MessageId,
  quote: ThreadMessageJumpQuote | null = null,
): void {
  pending = { threadKey, messageId, quote, at: Date.now() };
  notify();
}

/** The message this thread should open at, if a palette pick asked for one. */
export function pendingThreadMessageJump(threadKey: string): MessageId | null {
  return pending?.threadKey === threadKey && Date.now() - pending.at < PENDING_JUMP_MS
    ? pending.messageId
    : null;
}

/** The quoted text to highlight once the pending jump lands, if a citation asked for one. */
export function pendingThreadMessageJumpQuote(threadKey: string): ThreadMessageJumpQuote | null {
  return pendingThreadMessageJump(threadKey) === null ? null : (pending?.quote ?? null);
}

export function finishThreadMessageJump(threadKey: string): void {
  if (pending?.threadKey !== threadKey) return;
  pending = null;
  notify();
}

export function subscribeThreadMessageJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
