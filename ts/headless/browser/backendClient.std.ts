// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Browser -> headless backend calls, and remote versions of redux action
// creators: calling one runs the real (bound) action creator in the backend,
// whose resulting actions come back through the event stream.

import type { ActionCreatorsMapObject } from 'redux';

import { decodeWire, encodeWire } from '../wire.std.ts';

export async function callBackend(
  path: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: encodeWire(body, (argPath, kind) => {
      // oxlint-disable-next-line no-console
      console.warn(`${path}: dropping ${kind} at ${argPath}`, body);
    }),
  });
  if (!response.ok) {
    throw new Error(`${path} failed: HTTP ${response.status}`);
  }
  const result = decodeWire(await response.text()) as
    | { ok: true; value: unknown }
    | { ok: false; error: string };
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

type ActionLocation = Readonly<{ duck: string; name: string }>;

export function createRemoteActionBinder(
  registry: Readonly<Record<string, ActionCreatorsMapObject>>
): <T extends ActionCreatorsMapObject>(actions: T) => T {
  // Smart components bind whole ducks or hand-picked subsets, so resolve by
  // function identity rather than by object.
  const locations = new Map<unknown, ActionLocation>();
  for (const [duck, actions] of Object.entries(registry)) {
    for (const [name, fn] of Object.entries(actions)) {
      if (!locations.has(fn)) {
        locations.set(fn, { duck, name });
      }
    }
  }

  const cache = new WeakMap<object, unknown>();

  return <T extends ActionCreatorsMapObject>(actions: T): T => {
    const cached = cache.get(actions);
    if (cached) {
      return cached as T;
    }
    const bound: Record<string, unknown> = {};
    for (const [key, fn] of Object.entries(actions)) {
      const location = locations.get(fn);
      if (!location) {
        bound[key] = () => {
          throw new Error(
            `Action '${key}' is not a registered action creator; ` +
              'it cannot run in the browser'
          );
        };
        continue;
      }
      bound[key] = async (...args: Array<unknown>) => {
        try {
          return await callBackend('/api/action', { ...location, args });
        } catch (error) {
          // oxlint-disable-next-line no-console
          console.error(
            `action ${location.duck}.${location.name} failed`,
            error
          );
          throw error;
        }
      };
    }
    cache.set(actions, bound);
    return bound as T;
  };
}
