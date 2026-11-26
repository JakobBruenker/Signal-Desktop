// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces `node:crypto` in the browser build. UI code hashes small values
// synchronously (e.g. the backup key hash shown in settings), which Web
// Crypto can't do, so SHA-256/512 and HMAC are implemented here. Ciphers are
// left out: encryption only happens in the backend.

import { Buffer } from 'node:buffer';

// Hash functions are bitwise arithmetic throughout
/* oxlint-disable no-bitwise */

type Data = string | Uint8Array<ArrayBuffer>;

function toBytes(data: Data): Uint8Array<ArrayBuffer> {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

function concat(
  chunks: ReadonlyArray<Uint8Array<ArrayBuffer>>
): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// Message padding shared by SHA-256 (64-byte blocks, 8-byte length) and
// SHA-512 (128-byte blocks, 16-byte length)
function pad(
  message: Uint8Array<ArrayBuffer>,
  blockSize: number,
  lengthSize: number
) {
  const length =
    Math.ceil((message.length + 1 + lengthSize) / blockSize) * blockSize;
  const padded = new Uint8Array(length);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = BigInt(message.length) * 8n;
  view.setBigUint64(length - 8, bits);
  return { padded, view };
}

// ---- SHA-256

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// Indexed reads (in bounds by construction)
function at32(array: Uint32Array, i: number): number {
  return array[i] ?? 0;
}
function at64(array: ReadonlyArray<bigint>, i: number): bigint {
  return array[i] ?? 0n;
}

function sha256(message: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const { padded, view } = pad(message, 64, 8);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = at32(w, i - 15);
      const w2 = at32(w, i - 2);
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = at32(w, i - 16) + s0 + at32(w, i - 7) + s1;
    }
    let a = at32(h, 0);
    let b = at32(h, 1);
    let c = at32(h, 2);
    let d = at32(h, 3);
    let e = at32(h, 4);
    let f = at32(h, 5);
    let g = at32(h, 6);
    let hh = at32(h, 7);
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + at32(K256, i) + at32(w, i)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((value, i) => {
      h[i] = at32(h, i) + value;
    });
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((value, i) => outView.setUint32(i * 4, value));
  return out;
}

// ---- SHA-512 (BigInt arithmetic: slow, but inputs here are small)

const K512 = [
  '428a2f98d728ae22',
  '7137449123ef65cd',
  'b5c0fbcfec4d3b2f',
  'e9b5dba58189dbbc',
  '3956c25bf348b538',
  '59f111f1b605d019',
  '923f82a4af194f9b',
  'ab1c5ed5da6d8118',
  'd807aa98a3030242',
  '12835b0145706fbe',
  '243185be4ee4b28c',
  '550c7dc3d5ffb4e2',
  '72be5d74f27b896f',
  '80deb1fe3b1696b1',
  '9bdc06a725c71235',
  'c19bf174cf692694',
  'e49b69c19ef14ad2',
  'efbe4786384f25e3',
  '0fc19dc68b8cd5b5',
  '240ca1cc77ac9c65',
  '2de92c6f592b0275',
  '4a7484aa6ea6e483',
  '5cb0a9dcbd41fbd4',
  '76f988da831153b5',
  '983e5152ee66dfab',
  'a831c66d2db43210',
  'b00327c898fb213f',
  'bf597fc7beef0ee4',
  'c6e00bf33da88fc2',
  'd5a79147930aa725',
  '06ca6351e003826f',
  '142929670a0e6e70',
  '27b70a8546d22ffc',
  '2e1b21385c26c926',
  '4d2c6dfc5ac42aed',
  '53380d139d95b3df',
  '650a73548baf63de',
  '766a0abb3c77b2a8',
  '81c2c92e47edaee6',
  '92722c851482353b',
  'a2bfe8a14cf10364',
  'a81a664bbc423001',
  'c24b8b70d0f89791',
  'c76c51a30654be30',
  'd192e819d6ef5218',
  'd69906245565a910',
  'f40e35855771202a',
  '106aa07032bbd1b8',
  '19a4c116b8d2d0c8',
  '1e376c085141ab53',
  '2748774cdf8eeb99',
  '34b0bcb5e19b48a8',
  '391c0cb3c5c95a63',
  '4ed8aa4ae3418acb',
  '5b9cca4f7763e373',
  '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc',
  '78a5636f43172f60',
  '84c87814a1f0ab72',
  '8cc702081a6439ec',
  '90befffa23631e28',
  'a4506cebde82bde9',
  'bef9a3f7b2c67915',
  'c67178f2e372532b',
  'ca273eceea26619c',
  'd186b8c721c0c207',
  'eada7dd6cde0eb1e',
  'f57d4f7fee6ed178',
  '06f067aa72176fba',
  '0a637dc5a2c898a6',
  '113f9804bef90dae',
  '1b710b35131c471b',
  '28db77f523047d84',
  '32caab7b40c72493',
  '3c9ebe0a15c9bebc',
  '431d67c49c100d4c',
  '4cc5d4becb3e42b6',
  '597f299cfc657e2a',
  '5fcb6fab3ad6faec',
  '6c44198c4a475817',
].map(hex => BigInt(`0x${hex}`));

function sha512(message: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const mask = (x: bigint) => BigInt.asUintN(64, x);
  const rotr = (x: bigint, n: bigint) => mask((x >> n) | (x << (64n - n)));
  const h = [
    '6a09e667f3bcc908',
    'bb67ae8584caa73b',
    '3c6ef372fe94f82b',
    'a54ff53a5f1d36f1',
    '510e527fade682d1',
    '9b05688c2b3e6c1f',
    '1f83d9abfb41bd6b',
    '5be0cd19137e2179',
  ].map(hex => BigInt(`0x${hex}`));
  const { padded, view } = pad(message, 128, 16);
  const w = new Array<bigint>(80).fill(0n);
  for (let offset = 0; offset < padded.length; offset += 128) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getBigUint64(offset + i * 8);
    }
    for (let i = 16; i < 80; i += 1) {
      const w15 = at64(w, i - 15);
      const w2 = at64(w, i - 2);
      const s0 = rotr(w15, 1n) ^ rotr(w15, 8n) ^ (w15 >> 7n);
      const s1 = rotr(w2, 19n) ^ rotr(w2, 61n) ^ (w2 >> 6n);
      w[i] = mask(at64(w, i - 16) + s0 + at64(w, i - 7) + s1);
    }
    let a = at64(h, 0);
    let b = at64(h, 1);
    let c = at64(h, 2);
    let d = at64(h, 3);
    let e = at64(h, 4);
    let f = at64(h, 5);
    let g = at64(h, 6);
    let hh = at64(h, 7);
    for (let i = 0; i < 80; i += 1) {
      const s1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (mask(~e) & g);
      const t1 = mask(hh + s1 + ch + at64(K512, i) + at64(w, i));
      const s0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = mask(s0 + maj);
      hh = g;
      g = f;
      f = e;
      e = mask(d + t1);
      d = c;
      c = b;
      b = a;
      a = mask(t1 + t2);
    }
    [a, b, c, d, e, f, g, hh].forEach((value, i) => {
      h[i] = mask(at64(h, i) + value);
    });
  }
  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  h.forEach((value, i) => outView.setBigUint64(i * 8, value));
  return out;
}

const ALGORITHMS: Record<
  string,
  {
    digest: (data: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
    blockSize: number;
  }
> = {
  sha256: { digest: sha256, blockSize: 64 },
  sha512: { digest: sha512, blockSize: 128 },
};

function getAlgorithm(name: string) {
  const algorithm = ALGORITHMS[name.toLowerCase()];
  if (!algorithm) {
    throw new Error(`crypto (browser): unsupported hash ${name}`);
  }
  return algorithm;
}

type Encoding = 'hex' | 'base64' | 'base64url';

class Hash {
  readonly #chunks: Array<Uint8Array<ArrayBuffer>> = [];
  readonly #compute: (data: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;

  constructor(
    compute: (data: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>
  ) {
    this.#compute = compute;
  }

  update(data: Data): this {
    this.#chunks.push(toBytes(data));
    return this;
  }

  digest(): Buffer<ArrayBuffer>;
  digest(encoding: Encoding): string;
  digest(encoding?: Encoding): Buffer<ArrayBuffer> | string {
    const result = Buffer.from(this.#compute(concat(this.#chunks)));
    return encoding ? result.toString(encoding) : result;
  }
}

export function createHash(name: string): Hash {
  return new Hash(getAlgorithm(name).digest);
}

export function createHmac(name: string, key: Data): Hash {
  const { digest, blockSize } = getAlgorithm(name);
  let keyBytes = toBytes(key);
  if (keyBytes.length > blockSize) {
    keyBytes = digest(keyBytes);
  }
  const block = new Uint8Array(blockSize);
  block.set(keyBytes);
  const inner = block.map(byte => byte ^ 0x36);
  const outer = block.map(byte => byte ^ 0x5c);
  return new Hash(data =>
    digest(concat([outer, digest(concat([inner, data]))]))
  );
}

export function randomBytes(size: number): Buffer<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  // getRandomValues fills at most 64KiB at a time
  for (let offset = 0; offset < size; offset += 65536) {
    globalThis.crypto.getRandomValues(
      bytes.subarray(offset, Math.min(size, offset + 65536))
    );
  }
  return Buffer.from(bytes);
}

// Like Node: an integer in [min, max)
export function randomInt(min: number, max: number): number {
  const range = max - min;
  if (!Number.isSafeInteger(range) || range <= 0 || range > 2 ** 32) {
    throw new RangeError('randomInt: invalid range');
  }
  // Rejection sampling avoids modulo bias
  const limit = 2 ** 32 - (2 ** 32 % range);
  const value = new Uint32Array(1);
  let sample: number;
  do {
    globalThis.crypto.getRandomValues(value);
    sample = value[0] ?? 0;
  } while (sample >= limit);
  return min + (sample % range);
}

export function timingSafeEqual(
  left: Uint8Array<ArrayBuffer>,
  right: Uint8Array<ArrayBuffer>
): boolean {
  if (left.length !== right.length) {
    throw new RangeError('timingSafeEqual: lengths differ');
  }
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function unavailable(name: string): () => never {
  return () => {
    throw new Error(
      `node:crypto.${name} is not available in the browser (headless UI)`
    );
  };
}

export const createCipheriv = unavailable('createCipheriv');
export const createDecipheriv = unavailable('createDecipheriv');

const crypto = {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
};

export default crypto;
