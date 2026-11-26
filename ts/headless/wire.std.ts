// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// JSON encoding for redux state/actions sent between the headless backend and
// browser tabs. Plain JSON loses binary data and collections that appear in
// state (Uint8Array keys, Maps, Sets), so those are tagged.

const TAG = '$signalWire';

type Tagged =
  | { [TAG]: 'u8'; v: string }
  | { [TAG]: 'map'; v: Array<[unknown, unknown]> }
  | { [TAG]: 'set'; v: Array<unknown> }
  | { [TAG]: 'date'; v: number }
  | { [TAG]: 'bigint'; v: string }
  | { [TAG]: 'undefined' };

function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type UnsupportedValueReporter = (path: string, kind: string) => void;

function encodeValue(
  value: unknown,
  path: string,
  report: UnsupportedValueReporter | undefined
): unknown {
  if (value === undefined) {
    return { [TAG]: 'undefined' };
  }
  if (value == null || typeof value !== 'object') {
    if (typeof value === 'bigint') {
      return { [TAG]: 'bigint', v: value.toString() };
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
      report?.(path, typeof value);
      return null;
    }
    return value;
  }
  if (value instanceof Uint8Array) {
    // Only read, so the backing buffer type doesn't matter
    return { [TAG]: 'u8', v: toBase64(value as Uint8Array<ArrayBuffer>) };
  }
  if (value instanceof ArrayBuffer) {
    return { [TAG]: 'u8', v: toBase64(new Uint8Array(value)) };
  }
  if (value instanceof Date) {
    return { [TAG]: 'date', v: value.getTime() };
  }
  if (value instanceof Map) {
    return {
      [TAG]: 'map',
      v: Array.from(value, ([k, v], i) => [
        encodeValue(k, `${path}.<key${i}>`, report),
        encodeValue(v, `${path}.<value${i}>`, report),
      ]),
    };
  }
  if (value instanceof Set) {
    return {
      [TAG]: 'set',
      v: Array.from(value, (v, i) => encodeValue(v, `${path}[${i}]`, report)),
    };
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => encodeValue(v, `${path}[${i}]`, report));
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto != null) {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    report?.(path, proto?.constructor?.name ?? 'unknown class');
  }

  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    // `{ key: undefined }` and `{}` are equivalent for redux state; skipping
    // these keeps snapshots much smaller.
    if (v !== undefined) {
      result[key] = encodeValue(v, `${path}.${key}`, report);
    }
  }
  return result;
}

function isTagged(value: object): value is Tagged {
  return TAG in value;
}

function decodeValue(value: unknown): unknown {
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(decodeValue);
  }
  if (isTagged(value)) {
    switch (value[TAG]) {
      case 'u8':
        return fromBase64(value.v);
      case 'map':
        return new Map(
          value.v.map(([k, v]) => [decodeValue(k), decodeValue(v)])
        );
      case 'set':
        return new Set(value.v.map(decodeValue));
      case 'date':
        return new Date(value.v);
      case 'bigint':
        return BigInt(value.v);
      case 'undefined':
        return undefined;
      default:
        throw new Error('wire: unknown tag');
    }
  }
  const result: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    result[key] = decodeValue(v);
  }
  return result;
}

export function encodeWire(
  value: unknown,
  report?: UnsupportedValueReporter
): string {
  return JSON.stringify(encodeValue(value, '$', report));
}

export function decodeWire(text: string): unknown {
  return decodeValue(JSON.parse(text));
}
