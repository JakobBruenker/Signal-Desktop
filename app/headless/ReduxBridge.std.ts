// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Streams the backend's redux store to browser tabs: a snapshot on connect,
// then every action that reaches the reducers, in order. Tabs run the same
// reducers, so replaying actions keeps their copy of the state in sync.
//
// UI code also reads conversation models (window.ConversationController)
// directly, so their attributes travel along: all of them with the
// snapshot, and those of conversations an action changed with that action.

import type { Middleware, Store } from 'redux';

import { createLogger } from '../../ts/logging/log.std.ts';
import { encodeWire } from '../../ts/headless/wire.std.ts';

const log = createLogger('ReduxBridge');

export type BridgeClient = Readonly<{
  // Returns false if the client is gone or can't keep up; it is then dropped
  // and will reconnect (and get a fresh snapshot).
  send: (event: string, data: string) => boolean;
}>;

export type ConversationModelSource = Readonly<{
  // Attributes of the given conversations, or of all of them
  getAttributes: (
    ids?: ReadonlyArray<string>
  ) => Record<string, Readonly<Record<string, unknown>>>;
  getSignalConversationId: () => string | undefined;
}>;

type ConversationLookup = Readonly<Record<string, unknown>>;

function getConversationLookup(state: unknown): ConversationLookup {
  return (
    (state as { conversations?: { conversationLookup?: ConversationLookup } })
      .conversations?.conversationLookup ?? {}
  );
}

export class ReduxBridge {
  #store: Store | undefined;
  #seq = 0;
  readonly #clients = new Set<BridgeClient>();
  readonly #pending = new Set<BridgeClient>();
  readonly #reported = new Set<string>();
  readonly #conversations: ConversationModelSource;

  constructor(conversations: ConversationModelSource) {
    this.#conversations = conversations;
  }

  readonly middleware: Middleware =
    ({ getState }) =>
    next =>
    action => {
      const before = getConversationLookup(getState());
      const result = next(action);
      this.#seq += 1;
      if (this.#clients.size === 0) {
        return result;
      }

      // Conversations whose redux entry this action replaced or removed
      const after = getConversationLookup(getState());
      const changedIds: Array<string> = [];
      const removedIds: Array<string> = [];
      if (after !== before) {
        for (const [id, entry] of Object.entries(after)) {
          if (before[id] !== entry) {
            changedIds.push(id);
          }
        }
        for (const id of Object.keys(before)) {
          if (!(id in after)) {
            removedIds.push(id);
          }
        }
      }

      const data = encodeWire(
        {
          seq: this.#seq,
          action,
          ...(changedIds.length > 0
            ? {
                conversationAttributes:
                  this.#conversations.getAttributes(changedIds),
              }
            : {}),
          ...(removedIds.length > 0
            ? { removedConversationIds: removedIds }
            : {}),
        },
        this.#report
      );
      for (const client of this.#clients) {
        if (!client.send('action', data)) {
          this.#clients.delete(client);
        }
      }
      return result;
    };

  // Events outside the redux stream (notifications, sounds, badge count)
  broadcast(event: string, payload: unknown): void {
    const data = encodeWire(payload, this.#report);
    for (const client of this.#clients) {
      if (!client.send(event, data)) {
        this.#clients.delete(client);
      }
    }
  }

  setStore(store: Store): void {
    this.#store = store;
    for (const client of this.#pending) {
      this.#sendSnapshot(client);
    }
    this.#pending.clear();
  }

  get clientCount(): number {
    return this.#clients.size + this.#pending.size;
  }

  addClient(client: BridgeClient): void {
    if (!this.#store) {
      // App still starting; snapshot follows once the store is ready.
      this.#pending.add(client);
      return;
    }
    this.#sendSnapshot(client);
  }

  removeClient(client: BridgeClient): void {
    this.#clients.delete(client);
    this.#pending.delete(client);
  }

  #sendSnapshot(client: BridgeClient): void {
    if (!this.#store) {
      throw new Error('ReduxBridge: no store');
    }
    const data = encodeWire(
      {
        seq: this.#seq,
        state: this.#store.getState(),
        conversationAttributes: this.#conversations.getAttributes(),
        signalConversationId: this.#conversations.getSignalConversationId(),
      },
      this.#report
    );
    if (client.send('snapshot', data)) {
      this.#clients.add(client);
    }
  }

  // Values that can't cross the wire are dropped; log each place once.
  readonly #report = (path: string, kind: string): void => {
    const normalized = `${kind} at ${path.replace(/\[\d+\]/g, '[]')}`;
    // Paths include lookup keys (conversation ids, ...), so cap the total.
    if (this.#reported.has(normalized) || this.#reported.size >= 50) {
      return;
    }
    this.#reported.add(normalized);
    log.warn(`not serializable: ${normalized}`);
  };
}
