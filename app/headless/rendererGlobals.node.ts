// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Minimal browser environment for running the main window's renderer code in
// the main process. This is deliberately not a DOM implementation: the
// backend shouldn't render anything. Missing pieces should surface as errors
// so they can be moved to the browser UI or shimmed explicitly.

// oxlint-disable max-classes-per-file

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { drop } from '../../ts/util/drop.std.ts';

class MemoryStorage {
  readonly #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }
}

function createStyleDeclaration() {
  const properties = new Map<string, string>();
  return {
    setProperty(name: string, value: string) {
      properties.set(name, value);
    },
    removeProperty(name: string) {
      const old = properties.get(name) ?? '';
      properties.delete(name);
      return old;
    },
    getPropertyValue(name: string) {
      return properties.get(name) ?? '';
    },
  } as Record<string, unknown>;
}

class StubElement extends EventTarget {
  readonly tagName: string;
  readonly style = createStyleDeclaration();
  readonly dataset: Record<string, string> = {};
  readonly children: Array<StubElement> = [];
  readonly classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => false,
    contains: () => false,
  };

  innerHTML = '';
  textContent = '';

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  appendChild<T>(child: T): T {
    return child;
  }

  removeChild<T>(child: T): T {
    return child;
  }

  remove(): void {
    // no-op
  }

  setAttribute(): void {
    // no-op
  }

  getAttribute(): null {
    return null;
  }

  querySelector(): null {
    return null;
  }

  querySelectorAll(): Array<never> {
    return [];
  }

  closest(): null {
    return null;
  }

  focus(): void {
    // no-op
  }

  blur(): void {
    // no-op
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON: () => ({}),
    };
  }
}

const ELEMENT_CLASSES: Record<string, string> = {
  img: 'HTMLImageElement',
  video: 'HTMLVideoElement',
  audio: 'HTMLAudioElement',
};

function createDocument(
  locationHref: string,
  DocumentClass: new (tagName: string) => StubElement
) {
  const documentElement = new StubElement('html');
  const head = new StubElement('head');
  const body = new StubElement('body');

  const doc = Object.assign(new DocumentClass('#document'), {
    documentElement,
    head,
    body,
    title: 'Signal',
    hidden: true,
    visibilityState: 'hidden',
    readyState: 'complete',
    activeElement: body,
    location: new URL(locationHref),
    hasFocus: () => false,
    createElement: (tagName: string) => {
      // <img>/<video>/<audio> fail to load (see FailingSourceElement)
      const ctor = (globalThis as unknown as Record<string, unknown>)[
        ELEMENT_CLASSES[tagName.toLowerCase()] ?? ''
      ] as (new (tag: string) => StubElement) | undefined;
      return ctor ? new ctor(tagName) : new StubElement(tagName);
    },
    createElementNS: (_ns: string, tagName: string) => new StubElement(tagName),
    createTextNode: (text: string) => ({ textContent: text }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getSelection: () => null,
    implementation: {
      createHTMLDocument: () => createDocument(locationHref, DocumentClass),
    },
  });
  return doc;
}

// window.Notification in the backend; shown by browser tabs
export type HeadlessNotificationType = Readonly<{
  id: string;
  toJSON: () => Readonly<{
    id: string;
    title: string;
    body?: string;
    icon?: string;
    tag?: string;
  }>;
  trigger: (action: 'click' | 'close') => void;
}>;

type NotificationSink = Readonly<{
  show: (notification: HeadlessNotificationType) => void;
  close: (notification: HeadlessNotificationType) => void;
}>;

export function installRendererGlobals({
  rootDir,
  notifications,
}: {
  rootDir: string;
  notifications: NotificationSink;
}): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (g.window === globalThis) {
    throw new Error('installRendererGlobals: already installed');
  }

  const locationHref = pathToFileURL(join(rootDir, 'background.html')).href;

  g.window = globalThis;
  g.self = globalThis;
  g.top = globalThis;
  g.parent = globalThis;

  // window behaves as an EventTarget ('online', 'offline', 'storage', ...)
  const windowEvents = new EventTarget();
  g.addEventListener = windowEvents.addEventListener.bind(windowEvents);
  g.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
  g.dispatchEvent = windowEvents.dispatchEvent.bind(windowEvents);

  // UI libraries bundled alongside the backend code (react-aria, quill, ...)
  // inspect or patch DOM classes when imported. Give them inert classes.
  // Nothing is rendered in the backend.
  class StubNode extends StubElement {}
  for (const name of [
    'Node',
    'Element',
    'HTMLElement',
    'HTMLDivElement',
    'HTMLSpanElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLButtonElement',
    'HTMLAnchorElement',
    'HTMLImageElement',
    'HTMLVideoElement',
    'HTMLAudioElement',
    'HTMLMediaElement',
    'HTMLCanvasElement',
    'HTMLIFrameElement',
    'HTMLFormElement',
    'HTMLSelectElement',
    'HTMLLabelElement',
    'SVGElement',
    'SVGSVGElement',
    'Text',
    'Comment',
    'CharacterData',
    'DocumentFragment',
    'ShadowRoot',
    'Document',
    'HTMLDocument',
    'Range',
    'Selection',
  ]) {
    if (!(name in g)) {
      g[name] = class extends StubNode {};
    }
  }
  // Nothing loads in the backend: setting `src` fails asynchronously, like
  // a broken image would. Code waiting for 'load' must not hang. (Image
  // processing has a real implementation: ts/headless/backend/.)
  class FailingSourceElement extends StubNode {
    #src = '';
    onerror: ((event: Event) => void) | null = null;
    onload: ((event: Event) => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;

    get src(): string {
      return this.#src;
    }

    set src(value: string) {
      this.#src = value;
      setTimeout(() => {
        const event = new Event('error');
        this.dispatchEvent(event);
        this.onerror?.(event);
      }, 0);
    }
  }
  g.HTMLImageElement = class extends FailingSourceElement {};

  // Media: audio playback belongs in the browser tab, not the backend.
  class StubMediaElement extends FailingSourceElement {
    currentTime = 0;
    duration = NaN;
    paused = true;
    muted = false;
    volume = 1;
    playbackRate = 1;
    async play(): Promise<void> {
      // no-op
    }

    pause(): void {
      // no-op
    }

    load(): void {
      // no-op
    }
  }
  g.HTMLMediaElement = StubMediaElement;
  g.HTMLAudioElement = class extends StubMediaElement {};
  g.HTMLVideoElement = class extends StubMediaElement {};
  g.Audio = class extends StubMediaElement {
    constructor() {
      super('audio');
    }
  };
  g.Image = class extends (g.HTMLImageElement as typeof StubNode) {
    constructor() {
      super('img');
    }
  };
  // Node has Blob but not FileReader (used via blob-util's blobToArrayBuffer)
  g.FileReader = class FileReader extends EventTarget {
    result: ArrayBuffer | string | null = null;
    error: unknown = null;
    readyState = 0;
    onload: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onloadend: ((event: Event) => void) | null = null;

    #read(blob: Blob, convert: (blob: Blob) => Promise<ArrayBuffer | string>) {
      this.readyState = 1;
      drop(
        (async () => {
          let type: 'load' | 'error' = 'load';
          try {
            this.result = await convert(blob);
          } catch (error) {
            this.error = error;
            type = 'error';
          }
          this.readyState = 2;
          for (const name of [type, 'loadend'] as const) {
            const event = new Event(name);
            this.dispatchEvent(event);
            this[`on${name}`]?.(event);
          }
        })()
      );
    }

    readAsArrayBuffer(blob: Blob): void {
      this.#read(blob, b => b.arrayBuffer());
    }

    readAsText(blob: Blob): void {
      this.#read(blob, b => b.text());
    }

    readAsDataURL(blob: Blob): void {
      this.#read(
        blob,
        async b =>
          `data:${b.type || 'application/octet-stream'};base64,` +
          Buffer.from(await b.arrayBuffer()).toString('base64')
      );
    }
  };

  g.AudioContext = class extends EventTarget {
    state = 'suspended';
    async resume(): Promise<void> {
      // no-op
    }

    async close(): Promise<void> {
      // no-op
    }
  };

  for (const name of [
    'UIEvent',
    'MouseEvent',
    'KeyboardEvent',
    'FocusEvent',
    'InputEvent',
    'WheelEvent',
    'TouchEvent',
    'DragEvent',
    'ClipboardEvent',
    'CompositionEvent',
    'StorageEvent',
  ]) {
    if (!(name in g)) {
      g[name] = class extends Event {};
    }
  }
  class InertObserver {
    observe(): void {
      // no-op
    }

    unobserve(): void {
      // no-op
    }

    disconnect(): void {
      // no-op
    }

    takeRecords(): Array<never> {
      return [];
    }
  }
  for (const name of [
    'MutationObserver',
    'ResizeObserver',
    'IntersectionObserver',
  ]) {
    if (!(name in g)) {
      g[name] = InertObserver;
    }
  }

  g.location = new URL(locationHref);
  g.document = createDocument(
    locationHref,
    g.HTMLDocument as new (tagName: string) => StubElement
  );
  g.localStorage = new MemoryStorage();
  // Only used to detect a pre-SQLite legacy install; never answering makes
  // doesDatabaseExist() time out and report "no legacy database".
  g.indexedDB = {
    open: () => ({}),
    deleteDatabase: () => ({}),
  };
  g.sessionStorage = new MemoryStorage();

  // Node provides a `navigator` (userAgent, language, hardwareConcurrency,
  // platform). Add what browsers have and the app reads.
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries({
    onLine: true,
    languages: [nav.language ?? 'en-US'],
    // No cameras/microphones here; calls would use the browser tab's
    mediaDevices: {
      enumerateDevices: async () => [],
      getUserMedia: async () => {
        throw new Error('getUserMedia: no media devices in headless backend');
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    clipboard: undefined,
  })) {
    if (!(key in nav)) {
      Object.defineProperty(nav, key, { value, configurable: true });
    }
  }

  g.requestAnimationFrame = (cb: (time: number) => void) =>
    setTimeout(() => cb(performance.now()), 16);
  g.cancelAnimationFrame = (id: NodeJS.Timeout) => clearTimeout(id);
  g.requestIdleCallback = (
    cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void
  ) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1);
  g.cancelIdleCallback = (id: NodeJS.Timeout) => clearTimeout(id);

  g.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  });
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  g.devicePixelRatio = 1;
  g.innerWidth = 800;
  g.innerHeight = 600;

  // Shown by the connected browser tabs; clicks come back via trigger()
  g.Notification = class HeadlessNotification
    extends EventTarget
    implements HeadlessNotificationType
  {
    static permission = 'granted';
    static requestPermission = async () => 'granted';

    readonly id = randomUUID();
    readonly title: string;
    readonly options: NotificationOptions;
    onclick: ((event: Event) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    #closed = false;

    constructor(title: string, options: NotificationOptions = {}) {
      super();
      this.title = title;
      this.options = options;
      notifications.show(this);
    }

    toJSON() {
      return {
        id: this.id,
        title: this.title,
        body: this.options.body,
        icon: this.options.icon,
        tag: this.options.tag,
      };
    }

    trigger(action: 'click' | 'close'): void {
      const event = new Event(action);
      this.dispatchEvent(event);
      (action === 'click' ? this.onclick : this.onclose)?.(event);
    }

    close(): void {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      notifications.close(this);
    }
  };
}
