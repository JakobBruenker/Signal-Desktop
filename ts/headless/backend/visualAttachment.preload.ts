// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Headless backend replacement for ts/types/VisualAttachment.dom.ts. The
// originals need a real DOM (<img>, <canvas>); here images are decoded and
// scaled with @napi-rs/canvas. Everything else is the original module.

import { resolveObjectURL } from 'node:buffer';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas, Image } from '@napi-rs/canvas';

import { IMAGE_JPEG, IMAGE_PNG } from '../../types/MIME.std.ts';
import type { MIMEType } from '../../types/MIME.std.ts';
import { createLogger } from '../../logging/log.std.ts';
import type {
  CreatedThumbnailType,
  GetImageDimensionsOptionsType,
  MakeImageThumbnailForBackupOptionsType,
  MakeImageThumbnailOptionsType,
} from '../../types/VisualAttachment.dom.ts';
import { MAX_BACKUP_THUMBNAIL_SIZE } from '../../types/VisualAttachment.dom.ts';

export {
  TRANSCODABLE_VIDEO_FORMATS,
  blobToArrayBuffer,
  MAX_BACKUP_THUMBNAIL_SIZE,
  makeVideoScreenshot,
  estimateTranscodedVideoSize,
} from '../../types/VisualAttachment.dom.ts';
export type {
  CreatedThumbnailType,
  GetImageDimensionsOptionsType,
  MakeImageThumbnailForBackupOptionsType,
  MakeImageThumbnailOptionsType,
  MakeVideoScreenshotOptionsType,
  MakeVideoScreenshotResultType,
} from '../../types/VisualAttachment.dom.ts';

const log = createLogger('VisualAttachment(headless)');

// Same as the original
const STARTING_JPEG_QUALITY = 0.7;
const MINIMUM_JPEG_QUALITY = 0.1;
const ADDITIONAL_QUALITY_DECREASE_PER_ITERATION = 0.1;

// objectUrl is an attachment:// URL (served by main's protocol handler,
// which decrypts) or a blob: URL created in this process.
async function loadFromUrl(objectUrl: string): Promise<Image> {
  let bytes: ArrayBuffer;
  if (objectUrl.startsWith('blob:')) {
    const blob = resolveObjectURL(objectUrl);
    if (!blob) {
      throw new Error('loadFromUrl: unknown blob URL');
    }
    bytes = await blob.arrayBuffer();
  } else {
    const headless = window.SignalHeadless;
    if (!headless) {
      throw new Error('loadFromUrl: not running headless');
    }
    bytes = await headless.fetchLocalResource(objectUrl);
  }
  return loadImage(Buffer.from(bytes));
}

function encode(
  canvas: Canvas,
  contentType: MIMEType,
  quality?: number
): Promise<Buffer<ArrayBuffer>> {
  if (contentType === IMAGE_JPEG) {
    return canvas.encode(
      'jpeg',
      quality == null ? undefined : Math.round(quality * 100)
    );
  }
  if (contentType === 'image/webp') {
    return canvas.encode(
      'webp',
      quality == null ? undefined : Math.round(quality * 100)
    );
  }
  return canvas.encode('png');
}

export async function getImageDimensions({
  objectUrl,
}: GetImageDimensionsOptionsType): Promise<{ width: number; height: number }> {
  const image = await loadFromUrl(objectUrl);
  return { width: image.width, height: image.height };
}

// Square thumbnail: scale to cover, then crop the center
export async function makeImageThumbnail({
  size,
  objectUrl,
  contentType = IMAGE_PNG,
}: MakeImageThumbnailOptionsType): Promise<Blob> {
  const image = await loadFromUrl(objectUrl);
  const scale = Math.max(size / image.width, size / image.height);
  const width = image.width * scale;
  const height = image.height * scale;

  const canvas = createCanvas(size, size);
  canvas
    .getContext('2d')
    .drawImage(image, (size - width) / 2, (size - height) / 2, width, height);

  const data = await encode(canvas, contentType);
  return new Blob([new Uint8Array(data)], { type: contentType });
}

// Fit within maxDimension, then JPEG at decreasing quality until <= maxSize
export async function makeImageThumbnailForBackup({
  maxDimension = 256,
  maxSize = MAX_BACKUP_THUMBNAIL_SIZE,
  objectUrl,
}: MakeImageThumbnailForBackupOptionsType): Promise<CreatedThumbnailType> {
  const image = await loadFromUrl(objectUrl);
  const scale = Math.min(
    1,
    maxDimension / image.width,
    maxDimension / image.height
  );
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);

  let jpegQuality = STARTING_JPEG_QUALITY;
  let data = await encode(canvas, IMAGE_JPEG, jpegQuality);
  let iterations = 1;
  while (
    data.length > maxSize &&
    jpegQuality > MINIMUM_JPEG_QUALITY &&
    iterations < 5
  ) {
    jpegQuality = Math.max(
      MINIMUM_JPEG_QUALITY,
      (maxSize / data.length) * jpegQuality -
        ADDITIONAL_QUALITY_DECREASE_PER_ITERATION
    );
    // oxlint-disable-next-line no-await-in-loop
    data = await encode(canvas, IMAGE_JPEG, jpegQuality);
    iterations += 1;
  }

  if (data.length > maxSize) {
    log.warn(`backup thumbnail is ${data.length} bytes (max ${maxSize})`);
  }

  return {
    data: new Uint8Array(data),
    width,
    height,
    mimeType: IMAGE_JPEG,
  };
}
