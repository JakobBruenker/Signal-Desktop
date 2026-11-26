// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// JSON encoding for redux state/actions sent between the headless backend and
// browser tabs. Plain JSON loses binary data and collections that appear in
// state (Uint8Array keys, Maps, Sets), so those are tagged. Blobs and Files
// (attachments being sent) are uploaded separately and travel by id.

const TAG = '$signalWire';

type Tagged =
  | { [TAG]: 'u8'; v: string }
  | { [TAG]: 'map'; v: Array<[unknown, unknown]> }
  | { [TAG]: 'set'; v: Array<unknown> }
  | { [TAG]: 'date'; v: number }
  | { [TAG]: 'bigint'; v: string }
  | { [TAG]: 'undefined' }
  | ({ [TAG]: 'blob' } & WireBlob)
  | {
      [TAG]: 'response';
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
    };

type ResponseLike = Readonly<{
  status: number;
  statusText: string;
  headers: { forEach: (fn: (value: string, key: string) => void) => void };
  arrayBuffer: () => unknown;
}>;

// fetch() Responses, including node-fetch's (which aren't a global Response)
function isResponseLike(value: object): value is ResponseLike {
  const candidate = value as Partial<ResponseLike>;
  return (
    typeof candidate.status === 'number' &&
    typeof candidate.arrayBuffer === 'function' &&
    typeof candidate.headers?.forEach === 'function'
  );
}

// A Blob/File uploaded to the backend ahead of the message that refers to it
export type WireBlob = Readonly<{
  id: string;
  type: string;
  // Only for Files
  name?: string;
  lastModified?: number;
}>;

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

type EncodeContext = Readonly<{
  report?: UnsupportedValueReporter;
  // Upload ids of the Blobs in the value
  blobIds?: ReadonlyMap<Blob, string>;
}>;

function encodeValue(
  value: unknown,
  path: string,
  context: EncodeContext
): unknown {
  const { report } = context;
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
  if (isResponseLike(value)) {
    // Status and headers only; callers get the body separately (e.g.
    // BytesWithDetailsType.data)
    const headers: Array<[string, string]> = [];
    value.headers.forEach((v, k) => headers.push([k, v]));
    return {
      [TAG]: 'response',
      status: value.status,
      statusText: value.statusText,
      headers,
    };
  }
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) {
    // Cancelling isn't forwarded; the call just runs to completion
    return { [TAG]: 'undefined' };
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    const id = context.blobIds?.get(value);
    if (id == null) {
      report?.(path, 'Blob');
      return null;
    }
    return {
      [TAG]: 'blob',
      id,
      type: value.type,
      ...(value instanceof File
        ? { name: value.name, lastModified: value.lastModified }
        : {}),
    };
  }
  if (value instanceof Map) {
    return {
      [TAG]: 'map',
      v: Array.from(value, ([k, v], i) => [
        encodeValue(k, `${path}.<key${i}>`, context),
        encodeValue(v, `${path}.<value${i}>`, context),
      ]),
    };
  }
  if (value instanceof Set) {
    return {
      [TAG]: 'set',
      v: Array.from(value, (v, i) => encodeValue(v, `${path}[${i}]`, context)),
    };
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => encodeValue(v, `${path}[${i}]`, context));
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
      result[key] = encodeValue(v, `${path}.${key}`, context);
    }
  }
  return result;
}

function isTagged(value: object): value is Tagged {
  return TAG in value;
}

// Lets the receiver adjust string values by property name (e.g. URLs)
export type StringReviver = (key: string, value: string) => string;

type DecodeContext = Readonly<{
  revive?: StringReviver;
  resolveBlob?: (blob: WireBlob) => Blob;
}>;

function decodeValue(
  value: unknown,
  context: DecodeContext,
  key = ''
): unknown {
  const { revive } = context;
  if (typeof value === 'string') {
    return revive ? revive(key, value) : value;
  }
  if (value == null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => decodeValue(item, context, key));
  }
  if (isTagged(value)) {
    switch (value[TAG]) {
      case 'u8':
        return fromBase64(value.v);
      case 'map':
        return new Map(
          value.v.map(([k, v]) => [
            decodeValue(k, context),
            decodeValue(v, context),
          ])
        );
      case 'set':
        return new Set(value.v.map(item => decodeValue(item, context)));
      case 'date':
        return new Date(value.v);
      case 'bigint':
        return BigInt(value.v);
      case 'undefined':
        return undefined;
      case 'response': {
        // new Response() only accepts statuses 200-599
        const status =
          value.status >= 200 && value.status <= 599 ? value.status : 200;
        return new Response(null, {
          status,
          statusText: value.statusText,
          headers: value.headers,
        });
      }
      case 'blob':
        if (!context.resolveBlob) {
          throw new Error('wire: unexpected blob');
        }
        return context.resolveBlob(value);
      default:
        throw new Error('wire: unknown tag');
    }
  }
  const result: Record<string, unknown> = {};
  for (const [childKey, v] of Object.entries(value)) {
    result[childKey] = decodeValue(v, context, childKey);
  }
  return result;
}

export function encodeWire(
  value: unknown,
  report?: UnsupportedValueReporter,
  blobIds?: ReadonlyMap<Blob, string>
): string {
  return JSON.stringify(encodeValue(value, '$', { report, blobIds }));
}

export function decodeWire(
  text: string,
  revive?: StringReviver,
  resolveBlob?: (blob: WireBlob) => Blob
): unknown {
  return decodeValue(JSON.parse(text), { revive, resolveBlob });
}

// Blobs anywhere in a value (arrays, plain objects, Maps, Sets)
export function findBlobs(value: unknown, found = new Set<Blob>()): Set<Blob> {
  if (value == null || typeof value !== 'object') {
    return found;
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    found.add(value);
  } else if (value instanceof Map) {
    for (const [k, v] of value) {
      findBlobs(k, found);
      findBlobs(v, found);
    }
  } else if (Array.isArray(value) || value instanceof Set) {
    for (const item of value) {
      findBlobs(item, found);
    }
  } else if (!ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
    for (const v of Object.values(value)) {
      findBlobs(v, found);
    }
  }
  return found;
}
