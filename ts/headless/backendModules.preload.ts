// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Backend modules whose functions browser tabs may call (POST /api/module).
// The browser build replaces these modules with versions that forward here,
// so state they hold (caches, connections) stays in one place.

import * as WebAPI from '../textsecure/WebAPI.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';
import { ConversationModel } from '../models/conversations.preload.ts';
import * as processAttachment from '../util/processAttachment.preload.ts';

export const headlessBackendModules = {
  WebAPI,
  itemStorage,
  processAttachment,
  // Created during startup, so looked up when called
  get ConversationController(): typeof window.ConversationController {
    return window.ConversationController;
  },
  // Methods of a conversation's model (the browser's models forward their
  // async methods here)
  ConversationModel: {
    async call(
      conversationId: string,
      method: string,
      args: ReadonlyArray<unknown>
    ): Promise<unknown> {
      const model = window.ConversationController.get(conversationId);
      if (!model) {
        throw new Error(`ConversationModel.call: no ${conversationId}`);
      }
      const fn: unknown = Object.hasOwn(ConversationModel.prototype, method)
        ? Reflect.get(model, method)
        : undefined;
      if (typeof fn !== 'function' || method === 'constructor') {
        throw new Error(`ConversationModel.call: no method ${method}`);
      }
      return fn.apply(model, args);
    },
  },
};

export type HeadlessBackendModules = typeof headlessBackendModules;
