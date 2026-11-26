// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Temporary page served at / until the browser UI bundle exists: shows that
// the redux stream from the headless backend arrives intact.

export const DEBUG_PAGE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Signal (headless) - stream debug</title>
    <style>
      body { font: 14px system-ui, sans-serif; margin: 2rem; }
      code, pre { font: 12px ui-monospace, monospace; }
      .ok { color: #1a7f37; } .bad { color: #cf222e; }
      #actions { max-height: 60vh; overflow: auto; }
    </style>
  </head>
  <body>
    <h1>Signal headless backend</h1>
    <p>Stream: <strong id="status">connecting...</strong></p>
    <p id="summary"></p>
    <h2>Recent actions</h2>
    <pre id="actions"></pre>
    <script src="/debug.js"></script>
  </body>
</html>
`;

export const DEBUG_PAGE_JS = `'use strict';
const status = document.getElementById('status');
const summary = document.getElementById('summary');
const actionsEl = document.getElementById('actions');
let seq = 0;
let actionCount = 0;
let gaps = 0;
let snapshotInfo = '';
const recent = [];

function render() {
  summary.textContent =
    snapshotInfo + ' | actions since snapshot: ' + actionCount +
    ' | seq: ' + seq + ' | gaps: ' + gaps;
  actionsEl.textContent = recent.join('\\n');
}

const events = new EventSource('/api/events');
events.onopen = () => {
  status.textContent = 'connected, waiting for snapshot';
  status.className = '';
};
events.onerror = () => {
  status.textContent = 'disconnected (retrying)';
  status.className = 'bad';
};
events.addEventListener('snapshot', event => {
  const { seq: snapshotSeq, state } = JSON.parse(event.data);
  seq = snapshotSeq;
  actionCount = 0;
  gaps = 0;
  const conversations = Object.keys(
    (state.conversations && state.conversations.conversationLookup) || {}
  ).length;
  snapshotInfo =
    'snapshot: ' + Object.keys(state).length + ' slices, ' +
    conversations + ' conversations, ' +
    Math.round(event.data.length / 1024) + ' KiB';
  status.textContent = 'live';
  status.className = 'ok';
  render();
});
events.addEventListener('action', event => {
  const { seq: actionSeq, action } = JSON.parse(event.data);
  if (actionSeq !== seq + 1) {
    gaps += 1;
  }
  seq = actionSeq;
  actionCount += 1;
  recent.unshift(new Date().toLocaleTimeString() + '  #' + actionSeq + '  ' + action.type);
  recent.length = Math.min(recent.length, 200);
  render();
});
`;
