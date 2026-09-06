import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration.js';
import { testConfig } from '../../test/helpers.js';
import { ConversationStore } from './conversation.store.js';

const storeHolding = (maxConversations: number): ConversationStore => {
  const base = testConfig();
  const config: AppConfig = { ...base, llm: { ...base.llm, maxConversations } };
  return new ConversationStore(config);
};

const user = (content: string) => ({ role: 'user', content }) as const;
const assistant = (content: string) => ({ role: 'assistant', content }) as const;

describe('ConversationStore', () => {
  it('gives back the turns in the order they happened', () => {
    const store = storeHolding(10);
    store.append('c1', user('first'), assistant('answer'));
    store.append('c1', user('second'));

    expect(store.history('c1').map((turn) => turn.content)).toEqual(['first', 'answer', 'second']);
  });

  it('knows nothing about a conversation nobody started', () => {
    expect(storeHolding(10).history('never-seen')).toEqual([]);
  });

  it('keeps conversations apart', () => {
    const store = storeHolding(10);
    store.append('c1', user('mine'));
    store.append('c2', user('theirs'));

    expect(store.history('c1')).toEqual([user('mine')]);
    expect(store.history('c2')).toEqual([user('theirs')]);
  });

  it('does not record a turn with nothing in it', () => {
    // A cancelled turn produces an empty answer, and replaying it as an assistant
    // message teaches the model that empty replies are acceptable.
    const store = storeHolding(10);
    store.append('c1', user('a question'), assistant(''));
    store.append('c1', assistant('   '));

    expect(store.history('c1')).toEqual([user('a question')]);
  });

  it('drops the oldest turns once a conversation is long enough', () => {
    const store = storeHolding(10);
    for (let index = 0; index < 60; index += 1) store.append('c1', user(`turn ${String(index)}`));

    const history = store.history('c1');
    expect(history).toHaveLength(50);
    // The far end of a long conversation is what the model needs least.
    expect(history.at(0)?.content).toBe('turn 10');
    expect(history.at(-1)?.content).toBe('turn 59');
  });

  it('evicts the least recently used conversation, not the oldest one', () => {
    // A conversation the user is still in must not be forgotten because it began
    // before the ones they abandoned.
    const store = storeHolding(2);
    store.append('c1', user('one'));
    store.append('c2', user('two'));

    store.history('c1');
    store.append('c3', user('three'));

    expect(store.history('c1')).toEqual([user('one')]);
    expect(store.history('c2')).toEqual([]);
    expect(store.size).toBe(2);
  });

  it('never holds more conversations than it was told to', () => {
    const store = storeHolding(3);
    for (let index = 0; index < 20; index += 1) store.append(`c${String(index)}`, user('hello'));

    expect(store.size).toBe(3);
  });

  it('forgets a conversation on request, and is unbothered by one it never had', () => {
    const store = storeHolding(10);
    store.append('c1', user('one'));

    store.forget('c1');
    expect(() => {
      store.forget('never-seen');
    }).not.toThrow();
    expect(store.history('c1')).toEqual([]);
  });
});
