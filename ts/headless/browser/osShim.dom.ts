// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces `node:os` in the browser build with the backend's values.

import { bootData } from './electronShim.dom.ts';

const { os: info } = bootData;

export const platform = (): string => info.platform;
export const release = (): string => info.release;
export const arch = (): string => info.arch;
export const homedir = (): string => info.homedir;
export const tmpdir = (): string => info.tmpdir;
export const hostname = (): string => info.hostname;
export const type = (): string => info.type;
export const version = (): string => info.version;
export const EOL = info.platform === 'win32' ? '\r\n' : '\n';

const osShim = {
  platform,
  release,
  arch,
  homedir,
  tmpdir,
  hostname,
  type,
  version,
  EOL,
};
export default osShim;
