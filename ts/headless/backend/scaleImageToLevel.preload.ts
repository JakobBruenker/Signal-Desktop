// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Headless backend replacement for ts/util/scaleImageToLevel.preload.ts: the
// same quality levels and sizes, with @napi-rs/canvas instead of
// blueimp-load-image and <canvas>.

import type { MIMEType } from '../../types/MIME.std.ts';
import { IMAGE_JPEG } from '../../types/MIME.std.ts';
import { getCountryCode } from '../../types/PhoneNumber.std.ts';
import { getValue } from '../../RemoteConfig.std.ts';
import { itemStorage } from '../../textsecure/Storage.preload.ts';
import { drawToFit, encodeCanvas, loadImageFrom } from './images.preload.ts';
import type { Image } from '@napi-rs/canvas';

enum MediaQualityLevels {
  One = 1,
  Two = 2,
  Three = 3,
}

const DEFAULT_LEVEL = MediaQualityLevels.One;

const MiB = 1024 * 1024;

const DEFAULT_LEVEL_DATA = {
  maxDimensions: 1600,
  quality: 0.7,
  size: MiB,
  thresholdSize: 0.2 * MiB,
};

const MEDIA_QUALITY_LEVEL_DATA = new Map([
  [MediaQualityLevels.One, DEFAULT_LEVEL_DATA],
  [
    MediaQualityLevels.Two,
    {
      maxDimensions: 2048,
      quality: 0.75,
      size: MiB * 1.5,
      thresholdSize: 0.3 * MiB,
    },
  ],
  [
    MediaQualityLevels.Three,
    {
      maxDimensions: 4096,
      quality: 0.75,
      size: MiB * 3,
      thresholdSize: 0.4 * MiB,
    },
  ],
]);

const SCALABLE_DIMENSIONS = [3072, 2048, 1600, 1024, 768];
const MIN_DIMENSIONS = 512;

function parseCountryValues(values: string): Map<string, MediaQualityLevels> {
  const map = new Map<string, MediaQualityLevels>();
  values.split(',').forEach(value => {
    const [countryCode, level] = value.split(':');
    map.set(
      countryCode,
      Number(level) === 2 ? MediaQualityLevels.Two : MediaQualityLevels.One
    );
  });
  return map;
}

function getMediaQualityLevel(): MediaQualityLevels {
  const values = getValue('desktop.mediaQuality.levels');
  if (!values) {
    return DEFAULT_LEVEL;
  }

  const e164 = itemStorage.user.getOptionalNumber();

  const countryValues = parseCountryValues(values);
  const countryCode = getCountryCode(e164);

  const level = countryCode
    ? countryValues.get(String(countryCode))
    : undefined;
  if (level) {
    return level;
  }

  return countryValues.get('*') || DEFAULT_LEVEL;
}

function getCanvasBlobAsJPEG(
  image: Image,
  dimensions: number,
  quality: number
): Promise<Blob> {
  return encodeCanvas(
    drawToFit(image, dimensions, dimensions),
    IMAGE_JPEG,
    quality
  );
}

export async function scaleImageToLevel({
  fileOrBlobOrURL,
  contentType,
  size,
  highQuality,
}: {
  fileOrBlobOrURL: File | Blob | string;
  contentType: MIMEType;
  size: number;
  highQuality: boolean | null;
}): Promise<{
  blob: Blob;
  contentType: MIMEType;
}> {
  let image: Image;
  try {
    image = await loadImageFrom(fileOrBlobOrURL);
  } catch (cause) {
    throw new Error('scaleImageToLevel: Failed to process image', { cause });
  }

  const level = highQuality ? MediaQualityLevels.Three : getMediaQualityLevel();
  const {
    maxDimensions,
    quality,
    size: targetSize,
    thresholdSize,
  } = MEDIA_QUALITY_LEVEL_DATA.get(level) || DEFAULT_LEVEL_DATA;
  if (size <= thresholdSize) {
    // Always re-encoded, which also strips metadata (EXIF, GPS, ...)
    const blob = await encodeCanvas(
      drawToFit(image, image.width, image.height),
      contentType
    );
    return {
      blob,
      contentType,
    };
  }

  for (const scalableDimensions of SCALABLE_DIMENSIONS) {
    if (maxDimensions < scalableDimensions) {
      continue;
    }

    // We need these operations to be in serial
    // oxlint-disable-next-line no-await-in-loop
    const blob = await getCanvasBlobAsJPEG(image, scalableDimensions, quality);
    if (blob.size <= targetSize) {
      return {
        blob,
        contentType: IMAGE_JPEG,
      };
    }
  }

  const blob = await getCanvasBlobAsJPEG(image, MIN_DIMENSIONS, quality);
  return {
    blob,
    contentType: IMAGE_JPEG,
  };
}
