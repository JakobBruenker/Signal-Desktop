// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Browser replacement for ts/util/requestMicrophonePermissions.dom.ts. In a
// browser tab the browser asks for microphone access itself (getUserMedia),
// so Signal's own setting and permission popup (an Electron window) don't
// apply.

export async function requestMicrophonePermissions(
  _forCalling: boolean
): Promise<boolean> {
  return true;
}
