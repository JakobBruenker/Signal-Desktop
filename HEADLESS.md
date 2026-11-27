# Signal Desktop in a browser tab

This fork runs Signal Desktop without an app window. The Electron main
process runs the app's normal renderer code itself ("headless") and serves
the UI to browser tabs on `http://127.0.0.1:14500`. Your phone links it as a
regular linked device.

It is an unofficial modification. It uses its own data directory
(`%APPDATA%\Signal-web` on Windows) and doesn't touch an installed Signal.

## Running

Requirements: Node (see `.nvmrc`) and pnpm.

```sh
pnpm install
pnpm run build:rolldown
pnpm exec electron . --signal-web
```

`--signal-web` sets `SIGNAL_HEADLESS=1`, `NODE_ENV=development` and
`NODE_APP_INSTANCE=web`, which selects `config/local-development-web.json`
(production servers, `Signal-web` data directory, no auto-updates).

Don't run this build with `NODE_ENV=production`: that ignores
`NODE_APP_INSTANCE` and would use the regular Signal data directory.

On first start, open the URL written to
`%APPDATA%\Signal-web\headless-login-url.txt`. It sets a login cookie (valid
for a year); after that `http://127.0.0.1:14500/` is enough. Link the device
from your phone as usual.

To start it at login on Windows, put a shortcut in the Startup folder
(`shell:startup`) with target
`<repo>\node_modules\electron\dist\electron.exe "<repo>" --signal-web`.

## Security

- The server listens on 127.0.0.1 only.
- Every request needs the login cookie (random token, HttpOnly,
  SameSite=Strict). The token is stored in the data directory.
- Host headers are checked (against DNS rebinding) and POST requests must
  come from the page's own origin.
- Anyone who can read your data directory or run code as your user can use
  the session, as with Signal Desktop itself.

## How it works

- `app/headless/`: the main-process side. `HeadlessHost.main.ts` evaluates
  the renderer bundle in the main process with stand-ins for the DOM, the
  window and IPC; `LocalServer.main.ts` serves the UI and the API;
  `ReduxBridge.std.ts` streams redux state and actions to tabs (SSE).
- `ts/headless/browser/`: the browser build (`bundles/browser/app.js`). Tabs
  keep a replica of the redux store; action creators and some modules run on
  the backend through small HTTP calls.
- `ts/headless/backend/`: Node versions of DOM-dependent code (image
  processing with `@napi-rs/canvas`, sounds, link preview parsing).
- Work that needs a real browser, like decoding or transcoding video, is
  handed to a connected tab (`TabJobs.node.ts`, `tabJobs.dom.ts`).
- Changes to upstream files are kept small; search for `SignalHeadless` and
  `headless` to find them.

## Status

Works: chats, sending text, attachments, voice notes, GIFs, stickers,
reactions, replies, edits, deletes, link previews, search, notifications,
stories (viewing), settings.

Not supported: calls. Several tabs work, but they share one UI state (open
chat, dialogs), like a single app window.
