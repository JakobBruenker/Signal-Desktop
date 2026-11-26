// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Backend modules whose functions browser tabs may call (POST /api/module).
// The browser build replaces these modules with versions that forward here,
// so state they hold (caches, connections) stays in one place.

import * as WebAPI from '../textsecure/WebAPI.preload.ts';
import { itemStorage } from '../textsecure/Storage.preload.ts';

export const headlessBackendModules = {
  WebAPI,
  itemStorage,
  // Created during startup, so looked up when called
  get ConversationController(): typeof window.ConversationController {
    return window.ConversationController;
  },
};

export type HeadlessBackendModules = typeof headlessBackendModules;
