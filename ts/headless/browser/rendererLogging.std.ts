// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Browser replacement for ts/logging/set_up_renderer_logging.preload.ts. The
// backend keeps the log files; the browser UI logs to the devtools console.

export function beforeRestart(): void {
  // Nothing buffered to flush
}

export function initialize(): void {
  // Console logging is the default
}
