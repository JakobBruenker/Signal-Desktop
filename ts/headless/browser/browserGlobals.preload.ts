// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Node-style globals the UI code reads. Imported first by the browser entry.

import { Buffer } from 'node:buffer';

import { bootData } from './electronShim.dom.ts';
import { drop } from '../../util/drop.std.ts';

const g = globalThis as unknown as Record<string, unknown>;

// The buffer polyfill (v6) predates the 'base64url' encoding. Its base64
// decoder already accepts the URL-safe alphabet and missing padding, so
// decoding only needs the name mapped; encoding converts the output.
{
  type Fn = (...args: Array<unknown>) => unknown;
  const BufferClass = Buffer as unknown as Record<string, Fn>;
  const mapEncoding = (value: unknown) =>
    value === 'base64url' ? 'base64' : value;
  const wrapStatic = (name: string, encodingIndex: number) => {
    const original = BufferClass[name];
    if (!original) {
      return;
    }
    BufferClass[name] = function patched(this: unknown, ...args) {
      const mapped = [...args];
      mapped[encodingIndex] = mapEncoding(mapped[encodingIndex]);
      return original.apply(this, mapped);
    };
  };
  wrapStatic('from', 1);
  wrapStatic('byteLength', 1);
  wrapStatic('isEncoding', 0);

  const toString = Reflect.get(Buffer.prototype, 'toString') as Fn;
  Reflect.set(
    Buffer.prototype,
    'toString',
    function patchedToString(this: unknown, ...args: Array<unknown>) {
      if (args[0] !== 'base64url') {
        return toString.apply(this, args);
      }
      const base64 = toString.call(this, 'base64', args[1], args[2]) as string;
      return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
  );
}

g.global ??= globalThis;
g.Buffer ??= Buffer;
g.process ??= {
  // The backend's platform: the UI adapts to it (keyboard shortcuts, ...)
  platform: bootData.platform,
  env: {},
  versions: {},
  argv: [],
  browser: true,
  cwd: () => '/',
  nextTick: (fn: (...args: Array<unknown>) => void, ...args: Array<unknown>) =>
    queueMicrotask(() => fn(...args)),
};

// Full stacks for uncaught errors (the default console line lacks them)
window.addEventListener('error', event => {
  // oxlint-disable-next-line no-console
  console.error('uncaught:', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', event => {
  const { reason } = event;
  // oxlint-disable-next-line no-console
  console.error('unhandled rejection:', reason);
});

// Browser console errors/warnings also go to the backend's log, so problems
// in a tab show up in the Signal log files.
const MAX_ENTRY_LENGTH = 4000;
const MAX_PENDING = 100;
let pending: Array<{ level: string; text: string }> = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    // Firefox stacks don't include the message
    const header = `${arg.name}: ${arg.message}`;
    return arg.stack?.includes(arg.message)
      ? arg.stack
      : `${header}
${arg.stack ?? ''}`;
  }
  if (typeof arg === 'string') {
    return arg;
  }
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

async function flushLogs(): Promise<void> {
  flushTimer = undefined;
  const entries = pending;
  pending = [];
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
  } catch {
    // Backend unreachable; nothing sensible to do with the log lines
  }
}

function forwardConsole(level: 'error' | 'warn'): void {
  const original = console[level].bind(console);
  console[level] = (...args: Array<unknown>) => {
    original(...args);
    if (pending.length >= MAX_PENDING) {
      return;
    }
    pending.push({
      level,
      text: args.map(formatArg).join(' ').slice(0, MAX_ENTRY_LENGTH),
    });
    flushTimer ??= setTimeout(() => drop(flushLogs()), 1000);
  };
}
forwardConsole('error');
forwardConsole('warn');
