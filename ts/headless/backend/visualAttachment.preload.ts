// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Headless backend replacement for ts/types/VisualAttachment.dom.ts. The
// originals need a real DOM (<img>, <canvas>); here images are decoded and
// scaled with @napi-rs/canvas. Everything else is the original module.

import { createCanvas } from '@napi-rs/canvas';

import { IMAGE_JPEG, IMAGE_PNG } from '../../types/MIME.std.ts';
import { createLogger } from '../../logging/log.std.ts';
import type {
  CreatedThumbnailType,
  GetImageDimensionsOptionsType,
  MakeImageThumbnailForBackupOptionsType,
  MakeImageThumbnailOptionsType,
} from '../../types/VisualAttachment.dom.ts';
import { MAX_BACKUP_THUMBNAIL_SIZE } from '../../types/VisualAttachment.dom.ts';
import { drawToFit, encodeCanvas, loadImageFrom } from './images.preload.ts';

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

export async function getImageDimensions({
  objectUrl,
}: GetImageDimensionsOptionsType): Promise<{ width: number; height: number }> {
  const image = await loadImageFrom(objectUrl);
  return { width: image.width, height: image.height };
}

// Square thumbnail: scale to cover, then crop the center
export async function makeImageThumbnail({
  size,
  objectUrl,
  contentType = IMAGE_PNG,
}: MakeImageThumbnailOptionsType): Promise<Blob> {
  const image = await loadImageFrom(objectUrl);
  const scale = Math.max(size / image.width, size / image.height);
  const width = image.width * scale;
  const height = image.height * scale;

  const canvas = createCanvas(size, size);
  canvas
    .getContext('2d')
    .drawImage(image, (size - width) / 2, (size - height) / 2, width, height);

  return encodeCanvas(canvas, contentType);
}

// Fit within maxDimension, then JPEG at decreasing quality until <= maxSize
export async function makeImageThumbnailForBackup({
  maxDimension = 256,
  maxSize = MAX_BACKUP_THUMBNAIL_SIZE,
  objectUrl,
}: MakeImageThumbnailForBackupOptionsType): Promise<CreatedThumbnailType> {
  const image = await loadImageFrom(objectUrl);
  const canvas = drawToFit(image, maxDimension, maxDimension);
  const { width, height } = canvas;
  const encodeJpeg = async (quality: number) =>
    new Uint8Array(
      await (await encodeCanvas(canvas, IMAGE_JPEG, quality)).arrayBuffer()
    );

  let jpegQuality = STARTING_JPEG_QUALITY;
  let data = await encodeJpeg(jpegQuality);
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
    data = await encodeJpeg(jpegQuality);
    iterations += 1;
  }

  if (data.length > maxSize) {
    log.warn(`backup thumbnail is ${data.length} bytes (max ${maxSize})`);
  }

  return {
    data,
    width,
    height,
    mimeType: IMAGE_JPEG,
  };
}
