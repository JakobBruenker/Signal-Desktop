// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// window.ConversationController for the browser UI. Holds ConversationModels
// built from the backend's model attributes (streamed with redux updates, see
// app/headless/ReduxBridge.std.ts) and answers the lookups UI code makes.
// Anything else is forwarded to the backend's ConversationController.

import { ConversationModel } from '../../models/conversations.preload.ts';
import type { ConversationAttributesType } from '../../model-types.std.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { remoteFunction } from './remoteModule.std.ts';

type Attributes = Readonly<Record<string, unknown>>;

const callModelOnBackend = remoteFunction<
  (id: string, method: string, args: ReadonlyArray<unknown>) => unknown
>('ConversationModel', 'call');

function isAsyncFunction(fn: unknown): boolean {
  return typeof fn === 'function' && fn.constructor.name === 'AsyncFunction';
}

// Models whose async methods (loading, saving, sending: everything with side
// effects beyond this tab) run on the backend's model. Synchronous getters
// run locally on the streamed attributes.
function wrapModel(model: ConversationModel): ConversationModel {
  const forwarded = new Map<PropertyKey, unknown>();
  return new Proxy(model, {
    get(target, prop) {
      // `target` as receiver so #private fields work
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') {
        return value;
      }
      if (typeof prop === 'string' && isAsyncFunction(value)) {
        let fn = forwarded.get(prop);
        if (!fn) {
          fn = async (...args: Array<unknown>) =>
            callModelOnBackend(target.id, prop, args);
          forwarded.set(prop, fn);
        }
        return fn;
      }
      return value.bind(target);
    },
  });
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export class BrowserConversationController {
  readonly #byId = new Map<string, ConversationModel>();
  // What callers get: see wrapModel
  readonly #wrapped = new Map<string, ConversationModel>();
  // e164 / serviceId / pni / groupId -> id
  #byIdentifier = new Map<string, string>();
  #signalConversationId: string | undefined;
  readonly #warned = new Set<string>();

  // Snapshot: replaces everything
  reset(
    attributesById: Readonly<Record<string, Attributes>>,
    signalConversationId: string | undefined
  ): void {
    this.#byId.clear();
    this.#wrapped.clear();
    this.#signalConversationId = signalConversationId;
    this.update(attributesById, []);
  }

  update(
    attributesById: Readonly<Record<string, Attributes>>,
    removedIds: ReadonlyArray<string>
  ): void {
    for (const id of removedIds) {
      this.#byId.delete(id);
      this.#wrapped.delete(id);
    }
    for (const [id, attributes] of Object.entries(attributesById)) {
      const existing = this.#byId.get(id);
      if (existing) {
        // Replace, not merge: attributes may also have been removed
        const cleared = Object.fromEntries(
          Object.keys(existing.attributes).map(key => [key, undefined])
        );
        existing.set({ ...cleared, ...attributes }, { noTrigger: true });
      } else {
        const model = new ConversationModel(
          attributes as ConversationAttributesType
        );
        this.#byId.set(id, model);
        this.#wrapped.set(id, wrapModel(model));
      }
    }
    this.#reindex();
  }

  #reindex(): void {
    const index = new Map<string, string>();
    for (const [id, model] of this.#byId) {
      const { attributes } = model;
      for (const key of ['groupId', 'pni', 'serviceId', 'e164'] as const) {
        const value = asString(attributes[key]);
        if (value) {
          index.set(value, id);
        }
      }
    }
    this.#byIdentifier = index;
  }

  // Same resolution order as the original: e164, serviceId, pni, groupId, id
  get(identifier?: string | null): ConversationModel | undefined {
    if (!identifier) {
      return undefined;
    }
    const id =
      this.#byIdentifier.get(identifier) ??
      this.#byIdentifier.get(`+${identifier}`) ??
      identifier;
    return this.#wrapped.get(id);
  }

  getAll(): Array<ConversationModel> {
    return [...this.#wrapped.values()];
  }

  getConversationId(address: string | null): string | null {
    if (!address) {
      return null;
    }
    const [id] = address.split('.');
    return this.get(id)?.id ?? null;
  }

  getOurConversationId(): string | undefined {
    const aci = itemStorage.user.getAci();
    const pni = itemStorage.user.getOptionalPni();
    const e164 = itemStorage.user.getOptionalNumber();
    return (this.get(aci) ?? this.get(pni) ?? this.get(e164))?.id;
  }

  getOurConversationIdOrThrow(): string {
    const id = this.getOurConversationId();
    if (!id) {
      throw new Error('getOurConversationIdOrThrow: no conversation for us');
    }
    return id;
  }

  getOurConversation(): ConversationModel | undefined {
    return this.get(this.getOurConversationId());
  }

  getOurConversationOrThrow(): ConversationModel {
    const conversation = this.getOurConversation();
    if (!conversation) {
      throw new Error('getOurConversationOrThrow: no conversation for us');
    }
    return conversation;
  }

  isSignalConversationId(conversationId: string): boolean {
    return this.#signalConversationId === conversationId;
  }

  areWePrimaryDevice(): boolean {
    return itemStorage.user.getDeviceId() === 1;
  }

  doWeHaveOtherDevices(): boolean {
    const devices = window.reduxStore?.getState().linkedDevices.devices;
    return !this.areWePrimaryDevice() || Boolean(devices && devices.length > 0);
  }

  // Creation happens on the backend; here only existing ones can be found.
  lookupOrCreate({
    e164,
    serviceId,
  }: {
    e164?: string | null;
    serviceId?: string | null;
  }): ConversationModel | undefined {
    return this.get(serviceId) ?? this.get(e164);
  }

  // Local models only change through backend updates.
  conversationUpdated(): void {
    this.#warnOnce(
      'conversationUpdated',
      'a ConversationModel was modified in the browser; the change stays local'
    );
  }

  #warnOnce(key: string, message: string): void {
    if (!this.#warned.has(key)) {
      this.#warned.add(key);
      // oxlint-disable-next-line no-console
      console.warn(`BrowserConversationController: ${message}`);
    }
  }

  // Unknown methods run on the backend's ConversationController.
  static create(): BrowserConversationController {
    const controller = new BrowserConversationController();
    return new Proxy(controller, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol' || prop in target) {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        target.#warnOnce(prop, `${prop}() is forwarded to the backend (async)`);
        return remoteFunction('ConversationController', prop);
      },
    });
  }
}
