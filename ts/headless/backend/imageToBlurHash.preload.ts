// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Headless backend replacement for ts/util/imageToBlurHash.dom.ts, using
// @napi-rs/canvas instead of blueimp-load-image and <canvas>.

import { encode } from 'blurhash';

import { drawToFit, loadImageFrom } from './images.preload.ts';
import type { ImageSource } from './images.preload.ts';

export const imageToBlurHash = async (input: ImageSource): Promise<string> => {
  let image;
  try {
    image = await loadImageFrom(input);
  } catch (cause) {
    throw new Error('imageToBlurHash: Failed to process image', { cause });
  }
  // Same 200x200 limit as the original: blurhash is slow on large images
  const canvas = drawToFit(image, 200, 200);
  const { data, width, height } = canvas
    .getContext('2d')
    .getImageData(0, 0, canvas.width, canvas.height);
  // 4 horizontal components and 3 vertical components
  return encode(data, width, height, 4, 3);
};
