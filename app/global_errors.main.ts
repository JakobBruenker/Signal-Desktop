// Copyright 2018 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { app, dialog, clipboard } from 'electron';
import os from 'node:os';

import * as Errors from '../ts/types/errors.std.ts';
import { redactAll } from '../ts/util/privacy.node.ts';
import { drop } from '../ts/util/drop.std.ts';
import { createLogger } from '../ts/logging/log.std.ts';
import { reallyJsonStringify } from '../ts/util/reallyJsonStringify.std.ts';
import type { LocaleType } from './locale.node.ts';
import { isHeadlessMode } from './headless/mode.std.ts';

const log = createLogger('global_errors');

// We use hard-coded strings until we're able to update these strings from the locale.
let quitText = 'Quit';
let copyErrorAndQuitText = 'Copy error and quit';

function handleError(prefix: string, error: Error): void {
  const formattedError = Errors.toLogFormat(error);
  // oxlint-disable-next-line no-console
  console.error(`${prefix}:`, formattedError);
  log.error(`${prefix}:`, formattedError);

  if (app.isReady()) {
    // title field is not shown on macOS, so we don't use it
    const buttonIndex = dialog.showMessageBoxSync({
      buttons: [quitText, copyErrorAndQuitText],
      defaultId: 0,
      detail: redactAll(formattedError),
      message: prefix,
      noLink: true,
      type: 'error',
    });

    if (buttonIndex === 1) {
      drop(
        clipboard.writeText(
          `${prefix}\n\n${redactAll(formattedError)}\n\n` +
            `App Version: ${app.getVersion()}\n` +
            `OS: ${os.platform()}`
        )
      );
    }
  } else {
    dialog.showErrorBox(prefix, formattedError);
  }

  app.exit(1);
}

export const updateLocale = (locale: LocaleType): void => {
  quitText = locale.i18n('icu:quit');
  copyErrorAndQuitText = locale.i18n('icu:copyErrorAndQuit');
};

function _getError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const errorString = reallyJsonStringify(reason);
  return new Error(`Promise rejected with a non-error: ${errorString}`);
}

export const addHandler = (): void => {
  app.on('render-process-gone', (_event, _webContents, details) => {
    const { reason, exitCode } = details;

    if (reason === 'clean-exit') {
      return;
    }

    handleError(
      'Render process is gone',
      new Error(`Reason: ${reason}, Exit Code: ${exitCode}`)
    );
  });

  if (isHeadlessMode()) {
    // The main window's renderer code runs in this process. In a renderer,
    // these errors are logged and surfaced as window events; they must not
    // take down the whole app here either.
    process.on('uncaughtException', (reason: unknown) => {
      const error = _getError(reason);
      log.error('Unhandled Error (headless):', Errors.toLogFormat(error));
      globalThis.dispatchEvent?.(
        Object.assign(new Event('error'), { error, message: error.message })
      );
    });
    process.on('unhandledRejection', (reason: unknown) => {
      log.error(
        'Unhandled Promise Rejection (headless):',
        Errors.toLogFormat(_getError(reason))
      );
      globalThis.dispatchEvent?.(
        Object.assign(new Event('unhandledrejection'), { reason })
      );
    });
    return;
  }

  process.on('uncaughtException', (reason: unknown) => {
    handleError('Unhandled Error', _getError(reason));
  });

  process.on('unhandledRejection', (reason: unknown) => {
    handleError('Unhandled Promise Rejection', _getError(reason));
  });
};
