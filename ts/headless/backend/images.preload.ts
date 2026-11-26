// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Image decoding/encoding for the headless backend, which has no DOM <img> or
// <canvas>. @napi-rs/canvas applies EXIF orientation when decoding, and
// re-encoding drops all metadata (as the canvas path in Electron does).

import { resolveObjectURL } from 'node:buffer';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { Canvas, Image } from '@napi-rs/canvas';

import { IMAGE_JPEG } from '../../types/MIME.std.ts';
import type { MIMEType } from '../../types/MIME.std.ts';

// A Blob/File, or a URL: attachment:// and friends (served by main's
// protocol handlers, which decrypt) or a blob: URL created in this process.
export type ImageSource = Blob | string;

export async function readSource(source: ImageSource): Promise<Blob> {
  if (typeof source !== 'string') {
    return source;
  }
  if (source.startsWith('blob:')) {
    const blob = resolveObjectURL(source);
    if (!blob) {
      throw new Error('readSource: unknown blob URL');
    }
    return blob as Blob;
  }
  const headless = window.SignalHeadless;
  if (!headless) {
    throw new Error('readSource: not running headless');
  }
  return new Blob([await headless.fetchLocalResource(source)]);
}

export async function loadImageFrom(source: ImageSource): Promise<Image> {
  return loadImage(Buffer.from(await (await readSource(source)).arrayBuffer()));
}

// Scaled down (never up) to fit within the given box
export function drawToFit(
  image: Image,
  maxWidth: number,
  maxHeight: number
): Canvas {
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  return canvas;
}

// Like canvas.toBlob(): JPEG/WebP/PNG, anything else becomes PNG
export async function encodeCanvas(
  canvas: Canvas,
  contentType: MIMEType,
  quality?: number
): Promise<Blob> {
  const percent = quality == null ? undefined : Math.round(quality * 100);
  let data: Buffer<ArrayBuffer>;
  let type: string;
  if (contentType === IMAGE_JPEG) {
    data = await canvas.encode('jpeg', percent);
    type = IMAGE_JPEG;
  } else if (contentType === 'image/webp') {
    data = await canvas.encode('webp', percent);
    type = 'image/webp';
  } else {
    data = await canvas.encode('png');
    type = 'image/png';
  }
  return new Blob([new Uint8Array(data)], { type });
}
