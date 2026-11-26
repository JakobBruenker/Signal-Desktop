// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Work the backend can't do without a real browser (decoding video needs
// WebCodecs) is handed to one connected tab: it gets a 'job' event, fetches
// the input from /api/job/input, and posts the result to /api/job/result.
// The input is a Blob, or a URL served through main's protocol handlers
// (attachment://...), streamed rather than read into memory.

import { randomUUID } from 'node:crypto';

import type { ReduxBridge } from './ReduxBridge.std.ts';

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

export type TabJobInput = Blob | string;

type Job = Readonly<{
  input: TabJobInput;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}>;

export type TabJobResult = Readonly<
  { ok: true; value: unknown } | { ok: false; error: string }
>;

export class TabJobs {
  readonly #bridge: ReduxBridge;
  readonly #jobs = new Map<string, Job>();

  constructor(bridge: ReduxBridge) {
    this.#bridge = bridge;
  }

  run(
    kind: string,
    args: unknown,
    input: TabJobInput,
    { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#jobs.delete(id);
        reject(new Error(`tab job ${kind} timed out`));
      }, timeoutMs);
      this.#jobs.set(id, { input, resolve, reject, timer });
      if (!this.#bridge.sendToOne('job', { id, kind, args })) {
        clearTimeout(timer);
        this.#jobs.delete(id);
        reject(new Error(`tab job ${kind}: no browser tab connected`));
      }
    });
  }

  getInput(id: string): TabJobInput | undefined {
    return this.#jobs.get(id)?.input;
  }

  complete(id: string, result: TabJobResult): void {
    const job = this.#jobs.get(id);
    if (!job) {
      return;
    }
    this.#jobs.delete(id);
    clearTimeout(job.timer);
    if (result.ok) {
      job.resolve(result.value);
    } else {
      job.reject(new Error(`tab job failed: ${result.error}`));
    }
  }
}
