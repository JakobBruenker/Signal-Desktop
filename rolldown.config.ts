// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

import { readdirSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, relative } from 'node:path';
import { defineConfig } from 'rolldown';
import type { RolldownOptions } from 'rolldown';
import { transform } from 'oxc-transform';
import {
  getNodeStubSource,
  getRemoteModuleSource,
} from './ts/headless/browser/nodeStub.std.ts';

const external = [
  // Native libraries
  '@signalapp/libsignal-client',
  /^@signalapp\/libsignal-client\/.*/,
  '@signalapp/clonefile',
  '@signalapp/ringrtc',
  '@signalapp/sqlcipher',
  '@signalapp/mute-state-change',
  '@signalapp/windows-ucv',
  '@indutny/simple-windows-notifications',
  '@indutny/mac-screen-share',
  '@napi-rs/canvas',
  'electron',
  'fs-xattr',
  'fsevents',
  'mac-screen-capture-permissions',
  'sass',

  // Large libraries (3.7mb total)
  'google-libphonenumber',

  // Imported, but not used in production builds
  'mocha',

  // Electron's internal module
  'original-fs',

  // Uses fast-glob and dynamic requires
  './preload_test.preload.ts',
];

const isProd = process.argv.some(arg => arg === '--minify');

// Swaps app modules (by file name) for other implementations in one build.
// A replacement may import the module it replaces.
function fileReplacements(map: Record<string, string>) {
  return {
    name: 'file-replacements',
    resolveId(id: string, importer: string | undefined) {
      const replacement = map[id.split('/').pop() ?? ''];
      if (replacement != null && importer != null && importer !== replacement) {
        return replacement;
      }
      return undefined;
    },
  };
}

// Headless backend: DOM-dependent modules with Node implementations
const BACKEND_FILE_REPLACEMENTS: Record<string, string> = {
  'VisualAttachment.dom.ts': join(
    __dirname,
    'ts/headless/backend/visualAttachment.preload.ts'
  ),
};

// Browser UI build: Node built-ins and native/Node-only modules become stubs
// that throw when used (see ts/headless/browser/nodeStub.std.ts).
const BROWSER_STUB_PREFIX = '\0node-stub:';
const builtins = new Set(builtinModules);
// npm packages that only make sense in Node. Stubbed whole, because their
// own feature detection would otherwise trip over the built-in stubs.
const NODE_ONLY_PACKAGES = [
  'agent-base',
  'data-uri-to-buffer',
  'fast-glob',
  'fs-extra',
  'graceful-fs',
  'http-proxy-agent',
  'https-proxy-agent',
  'node-fetch',
  'proxy-agent',
  'socks',
  'socks-proxy-agent',
];
function isNodeOnlyModule(id: string): boolean {
  if (id === 'electron' || id === 'google-libphonenumber') {
    return false;
  }
  return (
    id.startsWith('node:') ||
    NODE_ONLY_PACKAGES.some(pkg => id === pkg || id.startsWith(`${pkg}/`)) ||
    builtins.has(id) ||
    builtins.has(id.split('/')[0] ?? '') ||
    external.some(entry =>
      typeof entry === 'string' ? entry === id : entry.test(id)
    )
  );
}
// Browser versions of `buffer`, `events` and `punycode` are only transitive
// dependencies; find them in the pnpm store.
function findPnpmPackage(
  name: string,
  majorVersion: number,
  mainFile: string
): string {
  const storeDir = join(__dirname, 'node_modules', '.pnpm');
  const entry = readdirSync(storeDir).find(dir =>
    dir.startsWith(`${name}@${majorVersion}.`)
  );
  if (entry == null) {
    throw new Error(`browser build: ${name}@${majorVersion} not installed`);
  }
  return join(storeDir, entry, 'node_modules', name, mainFile);
}
const browserBuffer = findPnpmPackage('buffer', 6, 'index.js');
const browserEvents = findPnpmPackage('events', 3, 'events.js');
const browserPunycode = findPnpmPackage('punycode', 2, 'punycode.es6.js');

// Node modules with a working browser replacement
const BROWSER_REPLACEMENTS: Record<string, string> = {
  'node:buffer': browserBuffer,
  buffer: browserBuffer,
  'node:events': browserEvents,
  events: browserEvents,
  punycode: browserPunycode,
  'node:punycode': browserPunycode,
  'node:url': join(__dirname, 'ts/headless/browser/urlShim.node.ts'),
  url: join(__dirname, 'ts/headless/browser/urlShim.node.ts'),
  'node:v8': join(__dirname, 'ts/headless/browser/v8Shim.std.ts'),
  v8: join(__dirname, 'ts/headless/browser/v8Shim.std.ts'),
  'node:path': join(__dirname, 'ts/headless/browser/pathShim.std.ts'),
  path: join(__dirname, 'ts/headless/browser/pathShim.std.ts'),
  'node:os': join(__dirname, 'ts/headless/browser/osShim.dom.ts'),
  os: join(__dirname, 'ts/headless/browser/osShim.dom.ts'),
  'node:util': join(__dirname, 'ts/headless/browser/utilShim.std.ts'),
  util: join(__dirname, 'ts/headless/browser/utilShim.std.ts'),
};
// App modules with a browser-specific implementation, by file name.
// STUB: replace with a throwing stub (backend-only modules with side effects
// at load time, like opening connections).
// { remote, local }: every export calls the backend module registered as
// `remote` (ts/headless/backendModules.preload.ts), except those `local`
// implements.
const STUB = Symbol('STUB');
type RemoteModule = Readonly<{ remote: string; local: string }>;
const BROWSER_REMOTE_PREFIX = '\0remote-module:';
const BROWSER_FILE_REPLACEMENTS: Record<
  string,
  string | typeof STUB | RemoteModule
> = {
  'basePaths.preload.ts': join(
    __dirname,
    'ts/headless/browser/basePaths.dom.ts'
  ),
  'preconnect.preload.ts': STUB,
  'WebAPI.preload.ts': {
    remote: 'WebAPI',
    local: join(__dirname, 'ts/headless/browser/webApi.dom.ts'),
  },
  'Storage.preload.ts': join(
    __dirname,
    'ts/headless/browser/itemStorage.preload.ts'
  ),
  'SignalProtocolStore.preload.ts': STUB,
  'set_up_renderer_logging.preload.ts': join(
    __dirname,
    'ts/headless/browser/rendererLogging.std.ts'
  ),
};
const browserNodeStubs = {
  name: 'browser-node-stubs',
  resolveId(id: string, importer: string | undefined) {
    const replacement = BROWSER_REPLACEMENTS[id];
    if (replacement != null) {
      return replacement;
    }
    const fileName = id.split('/').pop() ?? '';
    const fileReplacement = BROWSER_FILE_REPLACEMENTS[fileName];
    if (fileReplacement === STUB) {
      return `${BROWSER_STUB_PREFIX}${fileName}`;
    }
    if (typeof fileReplacement === 'object') {
      return `${BROWSER_REMOTE_PREFIX}${fileName}`;
    }
    // A replacement may import the module it replaces (to extend it)
    if (
      fileReplacement != null &&
      importer != null &&
      importer !== fileReplacement
    ) {
      return fileReplacement;
    }
    if (isNodeOnlyModule(id)) {
      return `${BROWSER_STUB_PREFIX}${id}`;
    }
    return undefined;
  },
  load(id: string) {
    if (id.startsWith(BROWSER_STUB_PREFIX)) {
      return getNodeStubSource(id.slice(BROWSER_STUB_PREFIX.length));
    }
    if (id.startsWith(BROWSER_REMOTE_PREFIX)) {
      const replacement =
        BROWSER_FILE_REPLACEMENTS[id.slice(BROWSER_REMOTE_PREFIX.length)];
      if (typeof replacement !== 'object') {
        throw new Error(`no remote module for ${id}`);
      }
      return getRemoteModuleSource({
        remote: replacement.remote,
        localPath: replacement.local,
        remoteHelperPath: join(
          __dirname,
          'ts/headless/browser/remoteModule.std.ts'
        ),
      });
    }
    return undefined;
  },
};

// Bundles evaluated by preload.wrapper.ts / app/headless/HeadlessHost.main.ts
// as `(function(require, __dirname, exports){ ... })`
const WRAPPED_BUNDLES = new Set(['preload/main.js', 'headless/backend.js']);

const sandboxPreload = {
  // Preload
  'preload/about': 'ts/windows/about/preload.sandbox.ts',
  'preload/calldiagnostic': 'ts/windows/calldiagnostic/preload.sandbox.ts',
  'preload/debuglog': 'ts/windows/debuglog/preload.sandbox.ts',
  'preload/pdf': 'ts/windows/pdf/preload.sandbox.ts',
  'preload/loading': 'ts/windows/loading/preload.sandbox.ts',
  'preload/permissions': 'ts/windows/permissions/preload.sandbox.ts',
  'preload/screenShare': 'ts/windows/screenShare/preload.sandbox.ts',
  'preload/sticker-creator': 'ts/windows/sticker-creator/preload.sandbox.ts',
};

const sandboxDOM = {
  'dom/about': 'ts/windows/about/app.dom.tsx',
  'dom/calldiagnostic': 'ts/windows/calldiagnostic/app.dom.tsx',
  'dom/debuglog': 'ts/windows/debuglog/app.dom.tsx',
  'dom/loading': 'ts/windows/loading/start.dom.ts',
  'dom/pdf': 'ts/windows/pdf/app.dom.tsx',
  'dom/permissions': 'ts/windows/permissions/app.dom.tsx',
  'dom/screenShare': 'ts/windows/screenShare/app.dom.tsx',
};

const defaults = {
  transform: {
    jsx: 'react-jsx',
    define: {
      'process.env.IS_BUNDLED': 'true',
    },
  },
  plugins: [
    {
      name: 'NODE_ENV',
      transform(code, id) {
        if (id.endsWith('.json')) {
          return;
        }

        const path = relative(__dirname, id);
        if (path.startsWith('app')) {
          return;
        }

        return transform(id, code, {
          define: {
            'process.env.NODE_ENV': isProd ? '"production"' : '"development"',
          },
          sourcemap: !isProd,
        });
      },
    },
  ],
  external,
  output: {
    format: 'cjs',
    dir: 'bundles',
    exports: 'named',
    chunkFileNames: 'chunks/[name]-[hash].js',
    generatedCode: {
      symbols: false,
    },
    sourcemap: !isProd,
    sourcemapBaseUrl: 'bundles:///',
    postBanner: ({ fileName }) => {
      // See preload.wrapper.ts
      if (WRAPPED_BUNDLES.has(fileName)) {
        return '(function(require, __dirname, exports){';
      }

      return '';
    },
    postFooter: ({ fileName }) => {
      const lines = new Array<string>();

      // See preload.wrapper.ts
      if (WRAPPED_BUNDLES.has(fileName)) {
        lines.push('})');
      }

      lines.push(`//# sourceURL=bundles:///${fileName}`);

      return lines.join('\n');
    },
  },
  watch: {
    clearScreen: false,
  },
} satisfies RolldownOptions;

if (isProd) {
  try {
    rmSync(join(__dirname, 'bundles'), { recursive: true });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error != null &&
      'code' in error &&
      error.code !== 'ENOENT'
    ) {
      throw error;
    }
  }
}

export default defineConfig([
  // Each sandboxed bundle has to be separate from the rest since
  // they cannot use `require()`
  ...Object.entries(sandboxPreload).map(([key, value]): RolldownOptions => {
    return {
      ...defaults,
      external: ['electron'],
      platform: 'browser',
      input: { [key]: value },
      output: {
        ...defaults.output,
        codeSplitting: false,
      },
    };
  }),
  {
    ...defaults,
    external: ['electron'],
    platform: 'browser',
    input: sandboxDOM,
    output: {
      ...defaults.output,
      format: 'es',
    },
  },
  {
    ...defaults,

    input: {
      // Main
      main: 'app/main.main.ts',
      config: 'app/config.main.js',

      // Preloads
      'preload/wrapper': 'preload.wrapper.ts',
      'preload/main': 'ts/windows/main/preload.preload.ts',

      // Workers
      'workers/sql': 'ts/sql/mainWorker.node.ts',
      'workers/heic': 'ts/workers/heicConverterWorker.node.ts',
    },
  },

  // Headless backend: the main window's renderer code, run inside the main
  // process (SIGNAL_HEADLESS=1). Must not share chunks with the main bundle,
  // otherwise both would share module-level state in one process.
  {
    ...defaults,
    input: {
      'headless/backend': 'ts/windows/main/preload.preload.ts',
    },
    plugins: [fileReplacements(BACKEND_FILE_REPLACEMENTS), ...defaults.plugins],
    output: {
      ...defaults.output,
      codeSplitting: false,
    },
  },

  // Headless: the main window UI for browser tabs
  {
    ...defaults,
    platform: 'browser',
    input: {
      'browser/app': 'ts/headless/browser/start.preload.tsx',
    },
    external: [],
    plugins: [browserNodeStubs, ...defaults.plugins],
    resolve: {
      alias: {
        electron: join(__dirname, 'ts/headless/browser/electronShim.dom.ts'),
      },
    },
    output: {
      ...defaults.output,
      format: 'es',
      codeSplitting: false,
    },
  },

  // Voice Note Worker
  {
    input: 'ts/workers/mp3Encoder.std.ts',
    transform: {
      define: {
        process: 'undefined',
        require: 'undefined',
        eval: 'undefined',
      },
    },
    output: {
      file: 'bundles/workers/mp3Encoder.js',
      exports: 'named',
      generatedCode: {
        symbols: false,
      },
      codeSplitting: false,
    },
    watch: {
      clearScreen: false,
    },
  },
]);
