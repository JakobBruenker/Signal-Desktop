// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// SIGNAL_HEADLESS=1: run the main window's renderer code in the main process
// with no BrowserWindow (see HeadlessHost.main.ts).
export function isHeadlessMode(): boolean {
  return Boolean(process.env.SIGNAL_HEADLESS);
}
