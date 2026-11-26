// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces `node:util` in the browser build with the commonly used helpers.

import { drop } from '../../util/drop.std.ts';

type Callback = (error: unknown, value?: unknown) => void;

export function promisify<Args extends Array<unknown>>(
  fn: (...args: [...Args, Callback]) => void
): (...args: Args) => Promise<unknown> {
  return (...args: Args) =>
    new Promise((resolve, reject) => {
      fn(...args, (error: unknown, value?: unknown) => {
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      });
    });
}

export function callbackify<Args extends Array<unknown>>(
  fn: (...args: Args) => Promise<unknown>
): (...args: [...Args, Callback]) => void {
  return (...args) => {
    const callback = args.pop() as Callback;
    drop(
      (async () => {
        let value: unknown;
        try {
          value = await fn(...(args as unknown as Args));
        } catch (error) {
          callback(error);
          return;
        }
        callback(null, value);
      })()
    );
  };
}

export function inspect(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function format(first: unknown, ...rest: Array<unknown>): string {
  if (typeof first !== 'string') {
    return [first, ...rest].map(inspect).join(' ');
  }
  let index = 0;
  const formatted = first.replace(/%[sdifjoO%]/g, token => {
    if (token === '%%') {
      return '%';
    }
    if (index >= rest.length) {
      return token;
    }
    const value = rest[index];
    index += 1;
    switch (token) {
      case '%s':
        return String(value);
      case '%d':
      case '%i':
        return String(Number.parseInt(String(value), 10));
      case '%f':
        return String(Number(value));
      default:
        return inspect(value);
    }
  });
  return [formatted, ...rest.slice(index).map(inspect)].join(' ');
}

export function inherits(
  ctor: { prototype: object; super_?: unknown },
  superCtor: { prototype: object }
): void {
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  // oxlint-disable-next-line no-param-reassign
  ctor.super_ = superCtor;
}

export function deprecate<T>(fn: T): T {
  return fn;
}

export function debuglog(): (...args: Array<unknown>) => void {
  return () => undefined;
}

export function styleText(_format: unknown, text: string): string {
  return text;
}

export function parseArgs(): never {
  throw new Error('util.parseArgs is unavailable in the browser');
}

export const types = {
  isUint8Array: (value: unknown): boolean => value instanceof Uint8Array,
  isPromise: (value: unknown): boolean => value instanceof Promise,
  isDate: (value: unknown): boolean => value instanceof Date,
  isRegExp: (value: unknown): boolean => value instanceof RegExp,
};

export const { TextEncoder, TextDecoder } = globalThis;

const utilShim = {
  promisify,
  callbackify,
  inspect,
  format,
  inherits,
  deprecate,
  debuglog,
  styleText,
  parseArgs,
  types,
  TextEncoder,
  TextDecoder,
};
export default utilShim;
