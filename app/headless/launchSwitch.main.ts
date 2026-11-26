// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// `electron . --signal-web` does what
// `SIGNAL_HEADLESS=1 NODE_ENV=development NODE_APP_INSTANCE=web` does, for
// shortcuts (Startup folder, ...), which can't set environment variables.
// Imported by config.main.ts, before it reads the environment.
//
// NODE_ENV is set explicitly: in production mode NODE_APP_INSTANCE is ignored
// and the regular Signal data directory would be used.

import { app } from 'electron';

if (process.argv.includes('--signal-web') && !app.isPackaged) {
  process.env.SIGNAL_HEADLESS = '1';
  process.env.NODE_ENV = 'development';
  process.env.NODE_APP_INSTANCE = 'web';
}
