// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Browser replacement for ts/textsecure/Storage.preload.ts. Reads come from
// the replica store's `items` (which mirrors the backend's itemStorage);
// writes go to the backend's itemStorage, so its cache, the database and
// redux are updated together.

import type { StorageAccessType } from '../../types/Storage.d.ts';
import {
  DEFAULT_AUTO_DOWNLOAD_ATTACHMENT,
  Storage as BackendStorage,
} from '../../textsecure/Storage.preload.ts';
import { remoteFunction } from './remoteModule.std.ts';

type Access = StorageAccessType;

const remotePut = remoteFunction<(key: string, value: unknown) => void>(
  'itemStorage',
  'put'
);
const remoteRemove = remoteFunction<(key: string) => void>(
  'itemStorage',
  'remove'
);

function getItems(): Partial<Access> | undefined {
  return window.reduxStore?.getState().items as Partial<Access> | undefined;
}

class BrowserStorage extends BackendStorage {
  public override get<K extends keyof Access>(
    key: K,
    defaultValue?: Access[K]
  ): Access[K] | undefined {
    const item = getItems()?.[key];
    return item === undefined ? defaultValue : item;
  }

  public override async put<K extends keyof Access>(
    key: K,
    value: Access[K]
  ): Promise<void> {
    await remotePut(key, value);
  }

  public override async remove<K extends keyof Access>(key: K): Promise<void> {
    await remoteRemove(key);
  }

  public override onready(callback: () => void): void {
    // The UI only renders once the replica store exists
    callback();
  }

  public override async fetch(): Promise<void> {
    // Nothing to load; reads go to the replica store
  }

  public override getItemsState(): Partial<Access> {
    return { ...getItems() };
  }
}

export { DEFAULT_AUTO_DOWNLOAD_ATTACHMENT, BrowserStorage as Storage };
export const itemStorage = new BrowserStorage();
