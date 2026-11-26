// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Files browser tabs upload (attachments to send, avatars, ...) ahead of the
// call that uses them, which refers to them by id (see WireBlob in
// ts/headless/wire.std.ts). Kept on disk and read lazily, since videos can be
// large; deleted after a while, and all of them on startup.

import { randomUUID } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createLogger } from '../../ts/logging/log.std.ts';
import * as Errors from '../../ts/types/errors.std.ts';
import type { WireBlob } from '../../ts/headless/wire.std.ts';
import { drop } from '../../ts/util/drop.std.ts';

const log = createLogger('UploadStore');

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
// Long enough for processing (e.g. video transcoding) to have read it
const UPLOAD_LIFETIME_MS = 60 * 60 * 1000;

type Upload = Readonly<{ path: string; blob: Blob }>;

export class UploadStore {
  readonly #dir: string;
  readonly #uploads = new Map<string, Upload>();

  constructor(userDataPath: string) {
    this.#dir = join(userDataPath, 'headless-uploads');
  }

  async init(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
    await mkdir(this.#dir, { recursive: true });
  }

  async receive(req: IncomingMessage): Promise<string> {
    const id = randomUUID();
    const path = join(this.#dir, id);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer<ArrayBuffer>, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          callback(new Error('upload too large'));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(req, limit, createWriteStream(path, { mode: 0o600 }));
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }

    this.#uploads.set(id, { path, blob: await openAsBlob(path) });
    setTimeout(() => drop(this.#delete(id)), UPLOAD_LIFETIME_MS).unref();
    return id;
  }

  resolve({ id, type, name, lastModified }: WireBlob): Blob {
    const upload = this.#uploads.get(id);
    if (!upload) {
      throw new Error(`UploadStore: unknown upload ${id}`);
    }
    if (name != null) {
      return new File([upload.blob], name, { type, lastModified });
    }
    return upload.blob.slice(0, upload.blob.size, type);
  }

  async #delete(id: string): Promise<void> {
    const upload = this.#uploads.get(id);
    if (!upload) {
      return;
    }
    this.#uploads.delete(id);
    try {
      await rm(upload.path, { force: true });
    } catch (error) {
      log.warn('failed to delete upload', Errors.toLogFormat(error));
    }
  }
}
