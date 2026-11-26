// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Runs the main window's renderer code (bundles/headless/backend.js) inside
// the main process, with no BrowserWindow. IPC between "renderer" and main is
// routed in-process, with the same async + structured-clone semantics as
// Electron IPC.

// oxlint-disable max-classes-per-file

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Script, constants } from 'node:vm';
// The full module is needed to build the renderer's `electron` shim.
// oxlint-disable-next-line signal-desktop/enforce-file-suffix
import * as electron from 'electron';

import { createLogger } from '../../ts/logging/log.std.ts';
import * as Errors from '../../ts/types/errors.std.ts';
import { strictAssert } from '../../ts/util/assert.std.ts';
import { drop } from '../../ts/util/drop.std.ts';
import { createHeadlessWindow } from './HeadlessWindow.main.ts';
import type { HeadlessBrowserWindow } from './HeadlessWindow.main.ts';
import { installRendererGlobals } from './rendererGlobals.node.ts';
import type { SignalHeadlessHooks } from '../../ts/headless/types.std.ts';

const log = createLogger('HeadlessHost');

type InvokeHandler = (event: unknown, ...args: Array<unknown>) => unknown;

function getInvokeHandlers(): Map<string, InvokeHandler> {
  // Electron keeps `ipcMain.handle` registrations here (IpcMainImpl).
  const handlers = (
    electron.ipcMain as unknown as {
      _invokeHandlers?: Map<string, InvokeHandler>;
    }
  )._invokeHandlers;
  strictAssert(
    handlers instanceof Map,
    'HeadlessHost: ipcMain._invokeHandlers not found; Electron internals changed'
  );
  return handlers;
}

// Electron IPC structured-clones every message, so neither side can observe
// the other's later mutations. Keep that guarantee.
function clone<T>(value: T): T {
  return structuredClone(value);
}

function nextTick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

class HeadlessIpcRenderer extends EventEmitter {
  readonly #host: HeadlessHost;

  constructor(host: HeadlessHost) {
    super();
    this.#host = host;
  }

  send(channel: string, ...args: Array<unknown>): void {
    const cloned = clone(args);
    setImmediate(() => this.#host.emitOnMain(channel, cloned));
  }

  sendSync(channel: string, ...args: Array<unknown>): unknown {
    return clone(this.#host.emitSyncOnMain(channel, clone(args)));
  }

  async invoke(channel: string, ...args: Array<unknown>): Promise<unknown> {
    const cloned = clone(args);
    await nextTick();
    return clone(await this.#host.invokeOnMain(channel, cloned));
  }

  postMessage(channel: string): void {
    throw new Error(
      `HeadlessIpcRenderer.postMessage(${channel}) is not supported`
    );
  }

  sendToHost(channel: string): void {
    throw new Error(`HeadlessIpcRenderer.sendToHost(${channel}) unsupported`);
  }
}

// The renderer only calls these synchronously at startup, and main answers
// some of them asynchronously (after an await). A real renderer process just
// blocks; we can't block in-process, so we fetch the answers before the
// renderer bundle is evaluated. All of them take no arguments.
const PREFETCHED_SYNC_CHANNELS = [
  'get-config',
  'native-theme:init',
  'locale-data',
  'country-display-names',
  'get-user-data-path',
  'OS.getClassName',
] as const;

const NO_RETURN_VALUE = Symbol('NO_RETURN_VALUE');

export class HeadlessHost {
  readonly window: HeadlessBrowserWindow;
  readonly asBrowserWindow: Electron.BrowserWindow;
  readonly #webContents: Electron.WebContents;
  readonly #ipcRenderer: HeadlessIpcRenderer;
  readonly #rendererEvent: { sender: HeadlessIpcRenderer; senderId: number };
  readonly #syncCache = new Map<string, unknown>();
  #reduxStore: Parameters<SignalHeadlessHooks['onAppReady']>[0] | undefined;

  constructor() {
    this.#ipcRenderer = new HeadlessIpcRenderer(this);
    this.#rendererEvent = { sender: this.#ipcRenderer, senderId: 0 };

    const { headless, asBrowserWindow, asWebContents } = createHeadlessWindow(
      (channel, args) => this.#deliverToRenderer(channel, args)
    );
    this.window = headless;
    this.asBrowserWindow = asBrowserWindow;
    this.#webContents = asWebContents;
  }

  // Available once the renderer app has started (used by the browser bridge).
  get reduxStore():
    | Parameters<SignalHeadlessHooks['onAppReady']>[0]
    | undefined {
    return this.#reduxStore;
  }

  // main -> renderer
  #deliverToRenderer(channel: string, args: ReadonlyArray<unknown>): void {
    const cloned = clone(args);
    setImmediate(() => {
      try {
        this.#ipcRenderer.emit(channel, this.#rendererEvent, ...cloned);
      } catch (error) {
        // Must stay below error level: main forwards error-level logs to the
        // renderer ('logging-error'), so logging an error here can loop.
        log.warn(
          `renderer listener for ${channel} threw`,
          Errors.toLogFormat(error)
        );
      }
    });
  }

  #makeMainEvent(
    onReturnValue?: (value: unknown) => void
  ): Electron.IpcMainEvent {
    const webContents = this.#webContents;
    let returnValue: unknown;
    const event = {
      sender: webContents,
      processId: process.pid,
      frameId: 1,
      ports: [],
      get returnValue() {
        return returnValue;
      },
      set returnValue(value: unknown) {
        returnValue = value;
        onReturnValue?.(value);
      },
      reply: (channel: string, ...args: Array<unknown>) =>
        webContents.send(channel, ...args),
      preventDefault() {
        // no-op
      },
      defaultPrevented: false,
    };
    return event as unknown as Electron.IpcMainEvent;
  }

  // renderer -> main (send)
  emitOnMain(
    channel: string,
    args: ReadonlyArray<unknown>,
    onReturnValue?: (value: unknown) => void
  ): void {
    const event = this.#makeMainEvent(onReturnValue);
    const handled = electron.ipcMain.emit(channel, event, ...args);
    if (!handled) {
      log.warn(`no ipcMain listener for '${channel}'`);
    }
  }

  // renderer -> main (sendSync)
  emitSyncOnMain(channel: string, args: ReadonlyArray<unknown>): unknown {
    if (args.length === 0 && this.#syncCache.has(channel)) {
      return this.#syncCache.get(channel);
    }
    let result: unknown = NO_RETURN_VALUE;
    this.emitOnMain(channel, args, value => {
      result = value;
    });
    if (result === NO_RETURN_VALUE) {
      throw new Error(
        `HeadlessHost: sendSync('${channel}') was answered asynchronously; ` +
          'add it to PREFETCHED_SYNC_CHANNELS'
      );
    }
    return result;
  }

  async #prefetchSyncChannels(): Promise<void> {
    await Promise.all(
      PREFETCHED_SYNC_CHANNELS.map(
        channel =>
          new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error(`prefetch of '${channel}' timed out`)),
              30_000
            );
            this.emitOnMain(channel, [], value => {
              clearTimeout(timeout);
              this.#syncCache.set(channel, value);
              resolve();
            });
          })
      )
    );
  }

  // renderer -> main (invoke)
  async invokeOnMain(
    channel: string,
    args: ReadonlyArray<unknown>
  ): Promise<unknown> {
    const handler = getInvokeHandlers().get(channel);
    if (!handler) {
      throw new Error(
        `Error invoking remote method '${channel}': ` +
          `Error: No handler registered for '${channel}'`
      );
    }
    try {
      return await handler(this.#makeMainEvent(), ...args);
    } catch (error) {
      // Same shape as Electron's renderer-side invoke errors
      throw new Error(
        `Error invoking remote method '${channel}': ${String(error)}`
      );
    }
  }

  #createElectronShim(): typeof electron {
    // Copy property descriptors rather than values: electron's exports are
    // lazy getters, some with side effects on first access. The bundle's
    // __toESM() helper copies own properties, so a Proxy won't do.
    const shim = Object.create(null) as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(electron)) {
      const descriptor = Object.getOwnPropertyDescriptor(electron, key);
      if (descriptor) {
        Object.defineProperty(shim, key, { ...descriptor, configurable: true });
      }
    }
    Object.assign(shim, {
      ipcRenderer: this.#ipcRenderer,
      contextBridge: {
        exposeInMainWorld(key: string, api: unknown) {
          (globalThis as Record<string, unknown>)[key] = api;
        },
      },
      webUtils: {
        getPathForFile() {
          throw new Error('webUtils.getPathForFile unsupported in headless');
        },
      },
    });
    return shim as unknown as typeof electron;
  }

  // Equivalent of loading background.html with preload.wrapper.ts
  async start(rootDir: string): Promise<void> {
    await this.#prefetchSyncChannels();
    installRendererGlobals({ rootDir });

    const bundleDir = join(rootDir, 'bundles', 'headless');
    const bundlePath = join(bundleDir, 'backend.js');
    const nodeRequire = createRequire(bundlePath);
    const electronShim = this.#createElectronShim();
    const rendererRequire = Object.assign(
      (id: string) => (id === 'electron' ? electronShim : nodeRequire(id)),
      nodeRequire
    );

    const window = globalThis as unknown as Record<string, unknown>;
    window.preloadCompileStartTime = Date.now();
    const hooks: SignalHeadlessHooks = {
      onAppReady: store => {
        this.#reduxStore = store;
        log.info(
          'app ready; redux store available with slices:',
          Object.keys(store.getState()).length
        );
      },
    };
    window.SignalHeadless = hooks;

    const script = new Script(readFileSync(bundlePath, 'utf8'), {
      filename: bundlePath,
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    const fn = script.runInThisContext({ displayErrors: true }) as (
      require: NodeJS.Require,
      dirname: string,
      exports: object
    ) => void;

    log.info('evaluating renderer bundle');
    fn(rendererRequire as NodeJS.Require, bundleDir, {});

    this.#webContents.emit('dom-ready');
    this.#webContents.emit('did-finish-load');
    this.window.emit('ready-to-show');

    const startApp = window.startApp as (() => Promise<void>) | undefined;
    strictAssert(startApp, 'renderer bundle did not expose startApp');
    log.info('calling startApp');
    // Like background.html: start the app, don't block window creation on it.
    drop(
      (async () => {
        try {
          await startApp();
        } catch (error) {
          log.error('startApp failed', Errors.toLogFormat(error));
        }
      })()
    );
  }
}
