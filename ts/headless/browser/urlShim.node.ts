// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Replaces `node:url` in the browser build. domainToUnicode matters: it's
// part of the "sneaky link" check (ts/types/LinkPreview.std.ts). `.node`
// only because of the punycode import, which the build maps to the npm
// package.

import punycode from 'node:punycode';

export const { URL, URLSearchParams } = globalThis;

export function domainToUnicode(domain: string): string {
  try {
    return punycode.toUnicode(domain.toLowerCase());
  } catch {
    // Same as Node for invalid input
    return '';
  }
}

export function domainToASCII(domain: string): string {
  try {
    return punycode.toASCII(domain.toLowerCase());
  } catch {
    return '';
  }
}

const urlShim = { URL, URLSearchParams, domainToUnicode, domainToASCII };
export default urlShim;
