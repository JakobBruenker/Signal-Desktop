// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces `node:path` in the browser build. The UI only manipulates paths
// that belong to the backend (attachment locations under its userData), so
// this follows the backend's platform: Windows-style when it runs on win32.

const isWindows =
  (globalThis as { process?: { platform?: string } }).process?.platform ===
  'win32';

export const sep = isWindows ? '\\' : '/';
export const delimiter = isWindows ? ';' : ':';

function splitPath(path: string): Array<string> {
  return path.split(isWindows ? /[\\/]+/ : /\/+/);
}

function getRoot(path: string): string {
  if (isWindows) {
    const drive = /^[a-zA-Z]:[\\/]?/.exec(path);
    if (drive) {
      return `${drive[0].slice(0, 2)}\\`;
    }
    return /^[\\/]/.test(path) ? '\\' : '';
  }
  return path.startsWith('/') ? '/' : '';
}

export function isAbsolute(path: string): boolean {
  return getRoot(path) !== '';
}

export function normalize(path: string): string {
  if (path === '') {
    return '.';
  }
  const root = getRoot(path);
  const parts: Array<string> = [];
  for (const part of splitPath(path.slice(root.length))) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!root) {
        parts.push('..');
      }
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join(sep);
  return root + joined || (root ? root : '.');
}

export function join(...paths: Array<string>): string {
  const nonEmpty = paths.filter(path => path !== '');
  return nonEmpty.length === 0 ? '.' : normalize(nonEmpty.join(sep));
}

export function resolve(...paths: Array<string>): string {
  let result = '';
  for (const path of paths) {
    result = isAbsolute(path) ? path : join(result, path);
  }
  return normalize(result);
}

export function dirname(path: string): string {
  const root = getRoot(path);
  const parts = splitPath(path.slice(root.length)).filter(Boolean);
  parts.pop();
  return root + parts.join(sep) || (root ? root : '.');
}

export function basename(path: string, ext?: string): string {
  const parts = splitPath(path).filter(Boolean);
  const base = parts[parts.length - 1] ?? '';
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

export function extname(path: string): string {
  const base = basename(path);
  const index = base.lastIndexOf('.');
  return index <= 0 ? '' : base.slice(index);
}

export function relative(from: string, to: string): string {
  const fromParts = splitPath(resolve(from)).filter(Boolean);
  const toParts = splitPath(resolve(to)).filter(Boolean);
  const same = (a: string, b: string) =>
    isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    same(fromParts[common] ?? '', toParts[common] ?? '')
  ) {
    common += 1;
  }
  return [
    ...fromParts.slice(common).map(() => '..'),
    ...toParts.slice(common),
  ].join(sep);
}

export function parse(path: string): {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
} {
  const base = basename(path);
  const ext = extname(path);
  return {
    root: getRoot(path),
    dir: dirname(path),
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
}

const pathShim = {
  sep,
  delimiter,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  parse,
};

export const posix = pathShim;
export const win32 = pathShim;
export default pathShim;
