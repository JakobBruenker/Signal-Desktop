// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// URLs with the app's own schemes (attachment:, emoji:, asset:) only load
// inside Electron. The headless browser UI installs a rewriter that maps
// them to its server; elsewhere this is the identity.

let rewriter: ((url: string) => string) | undefined;

export function setLoadableUrlRewriter(fn: (url: string) => string): void {
  rewriter = fn;
}

export function toLoadableUrl(url: string): string {
  return rewriter ? rewriter(url) : url;
}
