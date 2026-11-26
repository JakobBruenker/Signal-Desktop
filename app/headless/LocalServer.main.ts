// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// HTTP server for browser tabs in headless mode. Listens on 127.0.0.1 only.
// Every request needs the session cookie, obtained by opening the login URL
// (which carries a random token persisted in userData). Host headers are
// checked to defeat DNS rebinding; POSTs must come from our own origin.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { net } from 'electron';

import { createLogger } from '../../ts/logging/log.std.ts';
import * as Errors from '../../ts/types/errors.std.ts';
import { drop } from '../../ts/util/drop.std.ts';
import type { ReduxBridge } from './ReduxBridge.std.ts';
import { DEBUG_PAGE_HTML, DEBUG_PAGE_JS } from './debugPage.std.ts';
import { APP_PAGE_CSP, renderAppPage } from './appPage.std.ts';
import { decodeWire, encodeWire } from '../../ts/headless/wire.std.ts';

const log = createLogger('LocalServer');

const DEFAULT_PORT = 14500;
const COOKIE_NAME = 'signal_headless';
const SSE_HEARTBEAT_MS = 15_000;
// A tab that falls this far behind is dropped; it reconnects with a snapshot.
const SSE_MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

// Custom protocols the UI loads resources from. Served through the existing
// protocol.handle() handlers via net.fetch.
const PROXIED_PROTOCOLS = new Set(['attachment:', 'asset:', 'emoji:']);

// Directories under the app root that the UI loads directly.
const STATIC_DIRS = ['stylesheets', 'fonts', 'images', 'sounds'];

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

// What the backend offers browser tabs (implemented by HeadlessHost)
export type BrowserBackend = Readonly<{
  getBootData: () => unknown;
  invoke: (channel: string, args: ReadonlyArray<unknown>) => Promise<unknown>;
  send: (channel: string, args: ReadonlyArray<unknown>) => void;
  callAction: (
    duck: string,
    name: string,
    args: ReadonlyArray<unknown>
  ) => Promise<unknown>;
  dispatch: (action: unknown) => void;
  callModule: (
    module: string,
    name: string,
    args: ReadonlyArray<unknown>
  ) => Promise<unknown>;
  log: (entries: ReadonlyArray<{ level: string; text: string }>) => void;
  // User activity (clicks, keys) in a tab
  onTabActivity: () => void;
  // Focus/visibility/activity of a tab; undefined state = tab closed
  setTabState: (tabId: string, state: TabState | undefined) => void;
}>;

export type TabState = Readonly<{
  focused: boolean;
  visible: boolean;
}>;

type Options = Readonly<{
  rootDir: string;
  userDataPath: string;
  bridge: ReduxBridge;
  backend: BrowserBackend;
}>;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Array<Buffer<ArrayBuffer>> = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer<ArrayBuffer>).length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk as Buffer<ArrayBuffer>);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function loadOrCreateToken(userDataPath: string): string {
  const tokenPath = join(userDataPath, 'headless-token');
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function getCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index !== -1 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

export class LocalServer {
  readonly #options: Options;
  readonly #token: string;
  readonly #port: number;
  #server: Server | undefined;

  constructor(options: Options) {
    this.#options = options;
    this.#token = loadOrCreateToken(options.userDataPath);
    this.#port =
      Number.parseInt(process.env.SIGNAL_HEADLESS_PORT ?? '', 10) ||
      DEFAULT_PORT;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      drop(
        (async () => {
          try {
            await this.#handle(req, res);
          } catch (error) {
            log.error('request failed', Errors.toLogFormat(error));
            if (!res.headersSent) {
              res.writeHead(500);
            }
            res.end();
          }
        })()
      );
    });
    this.#server = server;

    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(this.#port, '127.0.0.1', () => {
        server.off('error', reject);
        resolvePromise();
      });
    });

    const loginUrl = `${this.origin}/login?token=${this.#token}`;
    writeFileSync(
      join(this.#options.userDataPath, 'headless-login-url.txt'),
      `${loginUrl}\n`,
      { mode: 0o600 }
    );
    log.info(`listening on ${this.origin}`);
    // Not via the logger: log files can end up in uploaded debug logs.
    // oxlint-disable-next-line no-console
    console.log(`\nSignal headless: open ${loginUrl}\n`);
  }

  #isAllowedHost(req: IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    return (
      host === `127.0.0.1:${this.#port}` || host === `localhost:${this.#port}`
    );
  }

  #isAuthenticated(req: IncomingMessage): boolean {
    const cookie = getCookie(req, COOKIE_NAME);
    return cookie != null && safeEqual(cookie, this.#token);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');

    if (!this.#isAllowedHost(req)) {
      res.writeHead(421).end();
      return;
    }

    const url = new URL(req.url ?? '/', this.origin);

    if (req.method === 'GET' && url.pathname === '/login') {
      const token = url.searchParams.get('token') ?? '';
      if (!safeEqual(token, this.#token)) {
        res.writeHead(403).end('Invalid token');
        return;
      }
      res.writeHead(302, {
        'Set-Cookie':
          `${COOKIE_NAME}=${this.#token}; HttpOnly; SameSite=Strict; ` +
          'Path=/; Max-Age=31536000',
        Location: '/',
      });
      res.end();
      return;
    }

    if (!this.#isAuthenticated(req)) {
      res
        .writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end(
          'Not logged in. Open the URL in headless-login-url.txt ' +
            '(in the Signal data directory).'
        );
      return;
    }

    if (req.method === 'POST') {
      if (req.headers.origin !== `http://${req.headers.host}`) {
        res.writeHead(403).end();
        return;
      }
      await this.#handlePost(req, res, url.pathname);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }

    if (url.pathname === '/') {
      this.#sendText(
        res,
        'text/html; charset=utf-8',
        renderAppPage(encodeWire(this.#options.backend.getBootData())),
        { 'Content-Security-Policy': APP_PAGE_CSP }
      );
      return;
    }
    if (url.pathname === '/debug') {
      this.#sendText(res, 'text/html; charset=utf-8', DEBUG_PAGE_HTML, {
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      return;
    }
    if (url.pathname === '/debug.js') {
      this.#sendText(res, 'text/javascript; charset=utf-8', DEBUG_PAGE_JS);
      return;
    }
    if (url.pathname === '/api/events') {
      this.#handleEvents(req, res, url.searchParams.get('tab'));
      return;
    }
    if (url.pathname === '/proto') {
      await this.#handleProtocol(req, res, url.searchParams.get('url') ?? '');
      return;
    }
    if (url.pathname.startsWith('/static/')) {
      await this.#handleStatic(req, res, url.pathname.slice('/static/'.length));
      return;
    }
    if (url.pathname.startsWith('/browser/')) {
      await this.#handleStatic(req, res, url.pathname.slice(1), 'bundles');
      return;
    }
    if (url.pathname.startsWith('/asset/')) {
      // asset:///<path> URLs, as rewritten in CSS (see #handleStatic)
      await this.#handleProtocol(
        req,
        res,
        `asset:///${url.pathname.slice('/asset/'.length)}`
      );
      return;
    }

    res.writeHead(404).end();
  }

  #sendText(
    res: ServerResponse,
    contentType: string,
    body: string,
    headers: Record<string, string> = {}
  ): void {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(body);
  }

  async #handlePost(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<void> {
    const { backend } = this.#options;
    let request: Record<string, unknown>;
    try {
      request = decodeWire(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400).end();
      return;
    }

    const reply = (result: unknown): void => {
      this.#sendText(res, 'application/json', encodeWire(result));
    };
    const run = async (fn: () => unknown) => {
      try {
        reply({ ok: true, value: await fn() });
      } catch (error) {
        reply({ ok: false, error: Errors.toLogFormat(error) });
      }
    };
    const args = Array.isArray(request.args) ? request.args : [];

    switch (pathname) {
      case '/api/ipc/invoke':
        await run(() => backend.invoke(String(request.channel), args));
        return;
      case '/api/ipc/send':
        await run(() => backend.send(String(request.channel), args));
        return;
      case '/api/action':
        await run(() =>
          backend.callAction(String(request.duck), String(request.name), args)
        );
        return;
      case '/api/dispatch':
        await run(() => backend.dispatch(request.action));
        return;
      case '/api/log':
        await run(() =>
          backend.log(
            (Array.isArray(request.entries) ? request.entries : []).map(
              (entry: { level?: unknown; text?: unknown }) => ({
                level: String(entry?.level),
                text: String(entry?.text),
              })
            )
          )
        );
        return;
      case '/api/window': {
        const tabId = String(request.tabId);
        await run(() => {
          backend.setTabState(tabId, {
            focused: request.focused === true,
            visible: request.visible === true,
          });
          if (request.active === true) {
            backend.onTabActivity();
          }
        });
        return;
      }
      case '/api/module':
        await run(() =>
          backend.callModule(String(request.module), String(request.name), args)
        );
        return;
      default:
        res.writeHead(404).end();
    }
  }

  #handleEvents(
    req: IncomingMessage,
    res: ServerResponse,
    tabId: string | null
  ): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const { bridge } = this.#options;
    const client = {
      send: (event: 'snapshot' | 'action', data: string): boolean => {
        if (res.destroyed || res.writableLength > SSE_MAX_BUFFERED_BYTES) {
          res.destroy();
          return false;
        }
        res.write(`event: ${event}\ndata: ${data}\n\n`);
        return true;
      },
    };
    const heartbeat = setInterval(
      () => res.write(': ping\n\n'),
      SSE_HEARTBEAT_MS
    );

    req.on('close', () => {
      clearInterval(heartbeat);
      bridge.removeClient(client);
      if (tabId) {
        this.#options.backend.setTabState(tabId, undefined);
      }
      log.info(`events: tab disconnected (${bridge.clientCount} connected)`);
    });

    bridge.addClient(client);
    log.info(`events: tab connected (${bridge.clientCount} connected)`);
  }

  async #handleProtocol(
    req: IncomingMessage,
    res: ServerResponse,
    target: string
  ): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!PROXIED_PROTOCOLS.has(parsed.protocol)) {
      res.writeHead(400).end();
      return;
    }

    const headers: Record<string, string> = {};
    if (typeof req.headers.range === 'string') {
      headers.range = req.headers.range;
    }
    const response = await net.fetch(parsed.href, {
      method: req.method,
      headers,
    });

    const outHeaders: Record<string, string> = { 'Cache-Control': 'no-store' };
    for (const name of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'content-disposition',
    ]) {
      const value = response.headers.get(name);
      if (value != null) {
        outHeaders[name] = value;
      }
    }
    // Some handlers (asset:) don't set one; fonts/images need it with nosniff
    outHeaders['content-type'] ??=
      CONTENT_TYPES[extname(parsed.pathname).toLowerCase()] ??
      'application/octet-stream';
    res.writeHead(response.status, outHeaders);
    if (!response.body || req.method === 'HEAD') {
      res.end();
      return;
    }
    Readable.fromWeb(response.body as NodeReadableStream).pipe(res);
  }

  async #handleStatic(
    req: IncomingMessage,
    res: ServerResponse,
    relativePath: string,
    // Subdirectory of the app root that relativePath is relative to
    container = ''
  ): Promise<void> {
    const rootDir = join(this.#options.rootDir, container);
    const topDir = decodeURIComponent(relativePath).split('/')[0];
    const allowed = container === 'bundles' ? ['browser'] : STATIC_DIRS;
    if (topDir == null || !allowed.includes(topDir)) {
      res.writeHead(404).end();
      return;
    }
    const base = resolve(rootDir, topDir);
    const filePath = resolve(rootDir, decodeURIComponent(relativePath));
    if (!filePath.startsWith(base + sep)) {
      res.writeHead(404).end();
      return;
    }
    let size: number;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        res.writeHead(404).end();
        return;
      }
      ({ size } = info);
    } catch {
      res.writeHead(404).end();
      return;
    }
    const contentType =
      CONTENT_TYPES[extname(filePath).toLowerCase()] ??
      'application/octet-stream';

    if (extname(filePath) === '.css') {
      // Stylesheets reference fonts etc. via asset:///
      const css = (await readFile(filePath, 'utf8')).replaceAll(
        'asset:///',
        '/asset/'
      );
      this.#sendText(res, contentType, css, { 'Cache-Control': 'no-cache' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>(resolvePromise =>
      server.close(() => resolvePromise())
    );
  }
}
