// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Runs work the backend hands to a tab because it needs a real browser (see
// app/headless/TabJobs.node.ts): fetch the input, run the original code on
// it, post the result back.

import {
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from 'mediabunny';

import {
  estimateTranscodedVideoSize,
  makeVideoScreenshot,
  TRANSCODABLE_VIDEO_FORMATS,
} from '../../types/VisualAttachment.dom.ts';
import { createUrlSource } from '../../util/urlSource.dom.ts';
import type { MIMEType } from '../../types/MIME.std.ts';
import { drop } from '../../util/drop.std.ts';
import { decodeWire } from '../wire.std.ts';
import { callBackend } from './backendClient.std.ts';

type JobHandler = (args: never, inputUrl: string) => Promise<unknown>;

const handlers: Record<string, JobHandler> = {
  async makeVideoScreenshot(
    { contentType }: { contentType: MIMEType },
    inputUrl
  ) {
    const { blob, ...rest } = await makeVideoScreenshot({
      objectUrl: inputUrl,
      contentType,
    });
    return { ...rest, screenshot: new Uint8Array(await blob.arrayBuffer()) };
  },
  async estimateTranscodedVideoSize(
    options: {
      duration: number;
      targetResolution: number;
      targetBitrate: number;
    },
    inputUrl
  ) {
    return estimateTranscodedVideoSize({ url: inputUrl, ...options });
  },
  // Same conversion as transcodeVideo() in ts/util/transcodeAttachment.preload.ts;
  // the backend encrypts the result.
  async transcodeVideo(
    {
      resolution,
      videoBitrateMbps,
    }: { resolution: number; videoBitrateMbps: number },
    inputUrl
  ) {
    const input = new Input({
      formats: TRANSCODABLE_VIDEO_FORMATS,
      source: createUrlSource(inputUrl),
    });
    const videoTrack = await input.getPrimaryVideoTrack();
    if (videoTrack == null) {
      throw new Error('No video track');
    }
    const [width, height] = await Promise.all([
      videoTrack.getDisplayWidth(),
      videoTrack.getDisplayHeight(),
    ]);

    const target = new BufferTarget();
    const output = new Output({
      target,
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    });

    // Compute rough bitrate over a second or so
    const { averageBitrate: sourceVideoBitrate } =
      await videoTrack.computePacketStats(30);
    const quality = new Quality({
      bitrate: Math.floor(Math.min(sourceVideoBitrate, videoBitrateMbps * 1e6)),
      bitrateMode: 'constant',
    });

    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video:
        width > height
          ? { quality, height: Math.min(height, resolution) }
          : { quality, width: Math.min(width, resolution) },
      // Don't preserve metadata
      tags: () => ({ creationTime: null }),
    });
    if (!conversion.isValid) {
      throw new Error('Failed to transcode');
    }
    await conversion.execute();

    if (!target.buffer) {
      throw new Error('Transcoding produced no output');
    }
    // Uploaded by callBackend (see backendClient.std.ts)
    return { video: new Blob([target.buffer], { type: 'video/mp4' }) };
  },
};

type JobEvent = Readonly<{ id: string; kind: string; args: never }>;

async function runJob({ id, kind, args }: JobEvent): Promise<void> {
  let result: Record<string, unknown>;
  try {
    const handler = handlers[kind];
    if (!handler) {
      throw new Error(`unknown job ${kind}`);
    }
    const response = await fetch(`/api/job/input?id=${encodeURIComponent(id)}`);
    if (!response.ok) {
      throw new Error(`job input: HTTP ${response.status}`);
    }
    const inputUrl = URL.createObjectURL(await response.blob());
    try {
      result = { ok: true, value: await handler(args, inputUrl) };
    } finally {
      URL.revokeObjectURL(inputUrl);
    }
  } catch (error) {
    result = { ok: false, error: String(error) };
  }
  await callBackend('/api/job/result', { id, ...result });
}

export function handleTabJobs(events: EventSource): void {
  events.addEventListener('job', event => {
    drop(runJob(decodeWire(event.data) as JobEvent));
  });
}
