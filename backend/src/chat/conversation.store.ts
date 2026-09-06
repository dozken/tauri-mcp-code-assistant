import { Inject, Injectable } from '@nestjs/common';
import { MAX_HISTORY_MESSAGES, type ChatHistoryMessage } from '@ai-code-companion/contracts';
import { APP_CONFIG, type AppConfig } from '../config/configuration.js';

/**
 * The turns of each conversation, held by the server rather than replayed by the
 * client.
 *
 * The client used to send its own transcript with every message, which was wrong
 * three ways: the payload grew with the conversation, the server had no record of
 * what it had actually said, and it took the client's word for it — a caller
 * could put words in the assistant's mouth and steer the next answer with them.
 *
 * Memory, not disk. A conversation is worth remembering for as long as the app is
 * open, and a restart is a new session — the transcript the user is looking at
 * lives in their window either way.
 */
@Injectable()
export class ConversationStore {
  /**
   * Insertion-ordered, which is what makes the eviction below a real LRU: a `Map`
   * iterates in insertion order, and re-inserting on touch moves an entry to the
   * end.
   */
  private readonly conversations = new Map<string, ChatHistoryMessage[]>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** The turns so far, oldest first. Empty for a conversation nobody has started. */
  history(conversationId: string): readonly ChatHistoryMessage[] {
    const turns = this.conversations.get(conversationId);
    if (turns === undefined) return [];

    // Touch: this conversation is the most recently used one now.
    this.conversations.delete(conversationId);
    this.conversations.set(conversationId, turns);

    return turns;
  }

  /** Records a turn. An empty answer is not recorded: there is nothing to replay. */
  append(conversationId: string, ...turns: readonly ChatHistoryMessage[]): void {
    const kept = turns.filter((turn) => turn.content.trim() !== '');
    if (kept.length === 0) return;

    const existing = this.conversations.get(conversationId) ?? [];
    this.conversations.delete(conversationId);
    // Oldest turns fall off the front: a conversation is bounded, and the far end
    // of a long one is what the model is least likely to need.
    this.conversations.set(conversationId, [...existing, ...kept].slice(-MAX_HISTORY_MESSAGES));

    this.evictLeastRecentlyUsed();
  }

  /** Forgets one conversation, for a client that wants to start over. */
  forget(conversationId: string): void {
    this.conversations.delete(conversationId);
  }

  /** How many conversations are held. The only thing worth reporting about it. */
  get size(): number {
    return this.conversations.size;
  }

  /**
   * Walks the keys in insertion order, dropping from the front until the store is
   * back within its limit. `history` re-inserts the conversation it is asked for,
   * so the front of that order is the least recently used one.
   *
   * Deleting while iterating a Map is defined behaviour, and iterating rather than
   * repeatedly asking for the first key is what keeps this loop from needing a
   * guard against a key that cannot be there.
   */
  private evictLeastRecentlyUsed(): void {
    for (const conversationId of this.conversations.keys()) {
      if (this.conversations.size <= this.config.llm.maxConversations) return;
      this.conversations.delete(conversationId);
    }
  }
}
