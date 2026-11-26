// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// The page browser tabs load: background.html's structure, with startup data
// for ts/headless/browser/electronShim.dom.ts embedded as JSON.

export const APP_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function renderAppPage(bootJson: string): string {
  // Embedded in a non-executed <script>; only `<` could end it early.
  const safeJson = bootJson.replace(/</g, '\\u003c');
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Signal</title>
    <link rel="icon" href="/static/images/signal-logo-desktop-linux.png" />
    <link href="/static/stylesheets/quill.css" rel="stylesheet" />
    <link href="/static/stylesheets/manifest.css" rel="stylesheet" />
    <link href="/static/stylesheets/tailwind.css" rel="stylesheet" />
    <script type="application/json" id="signal-boot">${safeJson}</script>
  </head>
  <body class="overflow-hidden">
    <div id="app-container">
      <div class="app-loading-screen app-loading-screen--before-app-load">
        <div class="module-splash-screen__logo module-splash-screen__logo--128"></div>
        <div class="dot-container">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
        <div class="message-placeholder"></div>
      </div>
    </div>
    <script type="module" src="/browser/app.js"></script>
  </body>
</html>
`;
}
