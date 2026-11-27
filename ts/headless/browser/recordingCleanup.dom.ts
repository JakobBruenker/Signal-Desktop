// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// A voice note recording lives in the tab that started it (the microphone is
// there), but its state is shared. If that tab goes away mid-recording, the
// recording is cancelled so other tabs don't keep showing it.

import { encodeWire } from '../wire.std.ts';

const START = 'audioRecorder/START_RECORDING';
const ENDS = new Set([
  'audioRecorder/CANCEL_RECORDING',
  'audioRecorder/COMPLETE_RECORDING',
  'audioRecorder/ERROR_RECORDING',
]);

let recordingInThisTab = false;

// Called with each action this tab dispatches
export function trackLocalAction(type: string): void {
  if (type === START) {
    recordingInThisTab = true;
  } else if (ENDS.has(type)) {
    recordingInThisTab = false;
  }
}

export function installRecordingCleanup(): void {
  window.addEventListener('pagehide', () => {
    if (!recordingInThisTab) {
      return;
    }
    // A beacon still goes out while the page unloads
    navigator.sendBeacon(
      '/api/dispatch',
      new Blob(
        [
          encodeWire({
            action: { type: 'audioRecorder/CANCEL_RECORDING', payload: null },
          }),
        ],
        { type: 'application/json' }
      )
    );
  });
}
