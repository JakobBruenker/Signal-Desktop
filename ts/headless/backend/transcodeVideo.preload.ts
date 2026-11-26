// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Video transcoding for the headless backend, which has no WebCodecs: a
// connected browser tab transcodes (see 'transcodeVideo' in
// ts/headless/browser/tabJobs.dom.ts), the result is encrypted to disk here
// like transcodeVideo() in ts/util/transcodeAttachment.preload.ts does.

import { Readable } from 'node:stream';

import { CURRENT_ATTACHMENT_VERSION } from '../../../app/attachments.node.ts';
import {
  encryptAttachmentV2ToDisk,
  generateKeys,
} from '../../AttachmentCrypto.node.ts';
import type { LocalAttachmentV2Type } from '../../types/Attachment.std.ts';
import { VIDEO_MP4 } from '../../types/MIME.std.ts';
import type { MIMEType } from '../../types/MIME.std.ts';
import { getAbsoluteAttachmentPath } from '../../util/migrations.preload.ts';

// Can take a while for long videos
const TRANSCODE_TIMEOUT_MS = 30 * 60 * 1000;

export type TabTranscodeOptions = Readonly<{
  resolution: number;
  videoBitrateMbps: number;
}>;

export async function transcodeVideoInTab(
  // Plaintext video (an attachment:// URL)
  url: string,
  { resolution, videoBitrateMbps }: TabTranscodeOptions
): Promise<LocalAttachmentV2Type & { contentType: MIMEType }> {
  const headless = window.SignalHeadless;
  if (!headless) {
    throw new Error('transcodeVideoInTab: not running headless');
  }
  const { video } = (await headless.runInTab(
    'transcodeVideo',
    { resolution, videoBitrateMbps },
    url,
    { timeoutMs: TRANSCODE_TIMEOUT_MS }
  )) as { video: Blob };

  const keys = generateKeys();
  const encrypted = await encryptAttachmentV2ToDisk({
    getAbsoluteAttachmentPath,
    keys,
    needIncrementalMac: false,
    plaintext: {
      stream: Readable.from(video.stream()),
      size: video.size,
    },
  });

  return {
    contentType: VIDEO_MP4,
    version: CURRENT_ATTACHMENT_VERSION,
    plaintextHash: encrypted.plaintextHash,
    size: video.size,
    path: encrypted.path,
    localKey: Buffer.from(keys).toString('base64'),
  };
}
