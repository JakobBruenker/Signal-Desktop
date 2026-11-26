// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Browser replacement for ts/util/basePaths.preload.ts: the backend resolves
// these on disk and sends them with the startup data.

import { bootData } from './electronShim.dom.ts';

const { basePaths } = bootData;

export const {
  ATTACHMENTS_PATH,
  DRAFT_PATH,
  STICKERS_PATH,
  TEMP_PATH,
  BADGES_PATH,
  AVATARS_PATH,
  DOWNLOADS_PATH,
  MEGAPHONES_PATH,
} = basePaths;
