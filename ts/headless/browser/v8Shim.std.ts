// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces `node:v8` in the browser build. The SQL client v8-serializes its
// arguments before ipcRenderer.invoke(); here serialize() just tags the value
// and the backend does the real v8 (de)serialization for browser requests
// (see LocalServer's /api/ipc/invoke handling).

export const V8_TAG = '$v8';

export type V8Tagged = Readonly<{ [V8_TAG]: unknown }>;

export function serialize(value: unknown): V8Tagged {
  return { [V8_TAG]: value };
}

export function deserialize(tagged: V8Tagged): unknown {
  if (tagged == null || typeof tagged !== 'object' || !(V8_TAG in tagged)) {
    throw new Error(
      'v8Shim.deserialize: value was not produced by the backend'
    );
  }
  return tagged[V8_TAG];
}

// Debug-only heap snapshot (ToastManager); not available in the browser
export function getHeapSnapshot(): never {
  throw new Error('v8.getHeapSnapshot is unavailable in the browser');
}

const v8Shim = { serialize, deserialize, getHeapSnapshot };
export default v8Shim;
