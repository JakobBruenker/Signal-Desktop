// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Source of the modules that replace Node built-ins and native modules in
// the browser UI build. The UI's import graph reaches backend code; those
// modules can be imported, but using anything from them throws. Code paths
// that need them at runtime must go through the backend instead.

export function getNodeStubSource(moduleId: string): string {
  return `
'use strict';
const SKIP = new Set(['__esModule', 'then', 'toJSON', '$$typeof', 'default']);
function make(path) {
  const fail = () => {
    throw new Error(path + ' is not available in the browser (headless UI)');
  };
  let proto;
  const handler = {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => path;
      if (typeof prop === 'symbol' || SKIP.has(prop)) return undefined;
      if (prop === 'prototype') return target.prototype;
      return make(path + '.' + prop);
    },
    // Lets namespace imports (which copy own props, then fall back to the
    // prototype chain) resolve any name.
    getPrototypeOf() {
      proto ??= new Proxy({}, { get: (_t, prop) => handler.get(target, prop) });
      return proto;
    },
    apply: fail,
    construct: fail,
  };
  const target = function () {};
  return new Proxy(target, handler);
}
module.exports = make(${JSON.stringify(moduleId)});
`;
}

// Source of a module whose exports call a backend module (see
// ts/headless/browser/remoteModule.std.ts), except those implemented
// locally in `localPath`.
export function getRemoteModuleSource({
  remote,
  localPath,
  remoteHelperPath,
}: {
  remote: string;
  localPath: string;
  remoteHelperPath: string;
}): string {
  return `
'use strict';
const local = require(${JSON.stringify(localPath)});
const { remoteFunction } = require(${JSON.stringify(remoteHelperPath)});
const cache = new Map();
module.exports = new Proxy({}, {
  get(_target, name) {
    if (typeof name !== 'string' || name === '__esModule' || name === 'then') {
      return undefined;
    }
    if (name in local) return local[name];
    let fn = cache.get(name);
    if (!fn) {
      fn = remoteFunction(${JSON.stringify(remote)}, name);
      cache.set(name, fn);
    }
    return fn;
  },
});
`;
}
