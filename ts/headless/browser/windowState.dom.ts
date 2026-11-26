// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Reports this tab's focus, visibility and user activity to the backend,
// which treats "any tab focused/visible" like the Electron window being
// focused/visible (read marking, notifications, ...). Also gives this tab's
// own activeWindowService the focus updates main would normally send.

import { throttle } from 'lodash';

import { callBackend } from './backendClient.std.ts';
import { ipcRenderer } from './electronShim.dom.ts';

// Same as ts/services/ActiveWindowService.std.ts
const ACTIVE_EVENTS = [
  'click',
  'keydown',
  'mousedown',
  'mousemove',
  'touchstart',
  'wheel',
];
const ACTIVITY_REPORT_INTERVAL = 5000;

export const tabId = crypto.randomUUID();

function isFocused(): boolean {
  return document.hasFocus();
}

function isVisible(): boolean {
  return document.visibilityState === 'visible';
}

async function report(active: boolean): Promise<void> {
  try {
    await callBackend('/api/window', {
      tabId,
      focused: isFocused(),
      visible: isVisible(),
      active,
    });
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.warn('window state report failed', error);
  }
}

const reportActivity = throttle(() => report(true), ACTIVITY_REPORT_INTERVAL, {
  trailing: false,
});

function onFocusChange(): void {
  ipcRenderer.deliver('set-window-focus', [isFocused()]);
  void report(false);
}

export function startWindowStateReporting(): void {
  window.addEventListener('focus', onFocusChange);
  window.addEventListener('blur', onFocusChange);
  document.addEventListener('visibilitychange', onFocusChange);
  for (const eventName of ACTIVE_EVENTS) {
    document.addEventListener(eventName, reportActivity, true);
  }
  onFocusChange();
}
