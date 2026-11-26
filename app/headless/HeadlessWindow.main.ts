// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Stand-ins for the main BrowserWindow and its WebContents when the app runs
// without a window (SIGNAL_HEADLESS=1). The main process keeps talking to
// "the window" exactly as before; these objects route that traffic to the
// in-process renderer code instead of a Chromium renderer.

// oxlint-disable max-classes-per-file

import { EventEmitter } from 'node:events';
import { session } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';

import { createLogger } from '../../ts/logging/log.std.ts';

const log = createLogger('HeadlessWindow');

type Deliver = (channel: string, args: ReadonlyArray<unknown>) => void;

// Any method we haven't implemented becomes a logged no-op rather than a
// crash, so main-process code that pokes at window chrome keeps working.
function withNoopFallback<T extends object>(target: T, name: string): T {
  const warned = new Set<string>();
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj || typeof prop === 'symbol' || prop === 'then') {
        // Use the real object as `this` so #private fields work.
        const value = Reflect.get(obj, prop, obj);
        if (typeof value !== 'function') {
          return value;
        }
        let fn = bound.get(prop);
        if (fn === undefined) {
          fn = value.bind(obj);
          bound.set(prop, fn);
        }
        return fn;
      }
      if (!warned.has(prop)) {
        warned.add(prop);
        log.warn(`${name}.${prop} is not implemented in headless mode`);
      }
      return () => undefined;
    },
  });
}

class HeadlessWebContents extends EventEmitter {
  readonly id = -1;
  readonly session = session.defaultSession;
  #destroyed = false;
  #zoomFactor = 1;
  readonly #deliver: Deliver;

  constructor(deliver: Deliver) {
    super();
    this.#deliver = deliver;
  }

  send(channel: string, ...args: Array<unknown>): void {
    if (this.#destroyed) {
      return;
    }
    this.#deliver(channel, args);
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  markDestroyed(): void {
    this.#destroyed = true;
    this.emit('destroyed');
  }

  getURL(): string {
    return 'headless://background';
  }

  isLoading(): boolean {
    return false;
  }

  getZoomFactor(): number {
    return this.#zoomFactor;
  }

  setZoomFactor(factor: number): void {
    this.#zoomFactor = factor;
  }

  getOSProcessId(): number {
    return process.pid;
  }

  getProcessId(): number {
    return process.pid;
  }

  isDevToolsOpened(): boolean {
    return false;
  }

  async executeJavaScript(): Promise<undefined> {
    return undefined;
  }
}

class HeadlessBrowserWindowImpl extends EventEmitter {
  readonly webContents: HeadlessWebContents;
  autoHideMenuBar = false;
  #visible = false;
  #focused = false;
  #destroyed = false;

  constructor(deliver: Deliver) {
    super();
    this.webContents = withNoopFallback(
      new HeadlessWebContents(deliver),
      'webContents'
    );
  }

  // Visibility & focus are driven by connected browser tabs (see
  // setAttached / setFocused), not by a real window.
  show(): void {
    if (!this.#visible) {
      this.#visible = true;
      this.emit('show');
    }
  }

  showInactive(): void {
    this.show();
  }

  hide(): void {
    if (this.#visible) {
      this.#visible = false;
      this.emit('hide');
    }
  }

  isVisible(): boolean {
    return this.#visible;
  }

  focus(): void {
    this.setFocused(true);
  }

  blur(): void {
    this.setFocused(false);
  }

  isFocused(): boolean {
    return this.#focused;
  }

  setFocused(focused: boolean): void {
    if (this.#focused === focused) {
      return;
    }
    this.#focused = focused;
    this.emit(focused ? 'focus' : 'blur');
  }

  isMinimized(): boolean {
    return false;
  }

  isMaximized(): boolean {
    return false;
  }

  isFullScreen(): boolean {
    return false;
  }

  isNormal(): boolean {
    return true;
  }

  getSize(): [number, number] {
    return [800, 600];
  }

  getContentSize(): [number, number] {
    return [800, 600];
  }

  getPosition(): [number, number] {
    return [0, 0];
  }

  getBounds(): Electron.Rectangle {
    return { x: 0, y: 0, width: 800, height: 600 };
  }

  isDestroyed(): boolean {
    return this.#destroyed;
  }

  close(): void {
    let defaultPrevented = false;
    this.emit('close', {
      preventDefault() {
        defaultPrevented = true;
      },
    });
    if (!defaultPrevented) {
      this.destroy();
    }
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    this.webContents.markDestroyed();
    this.emit('closed');
  }
}

export type HeadlessBrowserWindow = HeadlessBrowserWindowImpl;

export function createHeadlessWindow(deliver: Deliver): {
  headless: HeadlessBrowserWindow;
  asBrowserWindow: BrowserWindow;
  asWebContents: WebContents;
} {
  const headless = withNoopFallback(
    new HeadlessBrowserWindowImpl(deliver),
    'BrowserWindow'
  );
  return {
    headless,
    asBrowserWindow: headless as unknown as BrowserWindow,
    asWebContents: headless.webContents as unknown as WebContents,
  };
}
