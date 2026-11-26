// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces the `electron` module in the browser build. ipcRenderer talks to
// the headless backend over HTTP; the backend routes the calls into the same
// in-process ipcMain the backend renderer code uses.

import { decodeWire } from '../wire.std.ts';
import { callBackend } from './backendClient.std.ts';

type BootData = Readonly<{
  // Answers to the startup sendSync() channels, prefetched by the backend
  sync: Record<string, unknown>;
  // process.platform of the backend
  platform: string;
  // node:os values of the backend
  os: Readonly<
    Record<
      | 'platform'
      | 'release'
      | 'arch'
      | 'homedir'
      | 'tmpdir'
      | 'hostname'
      | 'type'
      | 'version',
      string
    >
  >;
  // ts/util/basePaths.preload.ts as resolved by the backend
  basePaths: Readonly<
    Record<
      | 'ATTACHMENTS_PATH'
      | 'DRAFT_PATH'
      | 'STICKERS_PATH'
      | 'TEMP_PATH'
      | 'BADGES_PATH'
      | 'AVATARS_PATH'
      | 'DOWNLOADS_PATH'
      | 'MEGAPHONES_PATH',
      string
    >
  >;
}>;

function readBootData(): BootData {
  const element = document.getElementById('signal-boot');
  if (!element?.textContent) {
    throw new Error('electronShim: missing #signal-boot data');
  }
  return decodeWire(element.textContent) as BootData;
}

export const bootData = readBootData();

type Listener = (event: unknown, ...args: Array<unknown>) => void;

class BrowserIpcRenderer {
  readonly #listeners = new Map<string, Set<Listener>>();
  // Keep send() ordering, like Electron's IPC channel
  #sendQueue: Promise<void> = Promise.resolve();

  sendSync(channel: string, ...args: Array<unknown>): unknown {
    if (args.length === 0 && channel in bootData.sync) {
      return bootData.sync[channel];
    }
    throw new Error(
      `ipcRenderer.sendSync('${channel}') unsupported in browser`
    );
  }

  async invoke(channel: string, ...args: Array<unknown>): Promise<unknown> {
    return callBackend('/api/ipc/invoke', { channel, args });
  }

  send(channel: string, ...args: Array<unknown>): void {
    const previous = this.#sendQueue;
    this.#sendQueue = (async () => {
      await previous;
      try {
        await callBackend('/api/ipc/send', { channel, args });
      } catch (error) {
        // oxlint-disable-next-line no-console
        console.error(`ipcRenderer.send('${channel}') failed`, error);
      }
    })();
  }

  on(channel: string, listener: Listener): this {
    let set = this.#listeners.get(channel);
    if (!set) {
      set = new Set();
      this.#listeners.set(channel, set);
    }
    set.add(listener);
    return this;
  }

  addListener(channel: string, listener: Listener): this {
    return this.on(channel, listener);
  }

  once(channel: string, listener: Listener): this {
    const wrapped: Listener = (event, ...args) => {
      this.removeListener(channel, wrapped);
      listener(event, ...args);
    };
    return this.on(channel, wrapped);
  }

  removeListener(channel: string, listener: Listener): this {
    this.#listeners.get(channel)?.delete(listener);
    return this;
  }

  off(channel: string, listener: Listener): this {
    return this.removeListener(channel, listener);
  }

  removeAllListeners(channel?: string): this {
    if (channel === undefined) {
      this.#listeners.clear();
    } else {
      this.#listeners.delete(channel);
    }
    return this;
  }

  listenerCount(channel: string): number {
    return this.#listeners.get(channel)?.size ?? 0;
  }

  // Called for main -> renderer messages forwarded by the backend
  deliver(channel: string, args: ReadonlyArray<unknown>): void {
    const event = { sender: this, senderId: 0 };
    for (const listener of [...(this.#listeners.get(channel) ?? [])]) {
      try {
        listener(event, ...args);
      } catch (error) {
        // oxlint-disable-next-line no-console
        console.error(`ipc listener for '${channel}' threw`, error);
      }
    }
  }
}

export const ipcRenderer = new BrowserIpcRenderer();

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    (window as unknown as Record<string, unknown>)[key] = api;
  },
};

export const webUtils = {
  getPathForFile(): string {
    throw new Error('webUtils.getPathForFile is unavailable in the browser');
  },
};

const electronShim = { ipcRenderer, contextBridge, webUtils };
export default electronShim;
