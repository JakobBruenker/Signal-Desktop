// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { Store } from 'redux';

import type { StateType } from '../state/reducer.preload.ts';

// Present as `window.SignalHeadless` when the main window's renderer code runs
// headless inside the main process (see app/headless/HeadlessHost.main.ts).
// The UI is then rendered by connected browser tabs instead.
export type SignalHeadlessHooks = Readonly<{
  onAppReady: (store: Store<StateType>) => void;
}>;
