// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Browser versions of ts/textsecure/WebAPI.preload.ts exports that can't be
// remote calls (synchronous ones). Everything else WebAPI exports runs on the
// backend (see BROWSER_FILE_REPLACEMENTS in rolldown.config.ts).

export function isOnline(): boolean | undefined {
  return window.reduxStore?.getState().network.isOnline;
}

export function onHasStoriesDisabledChange(): void {
  // The backend's socket manager reacts to the setting itself
}
