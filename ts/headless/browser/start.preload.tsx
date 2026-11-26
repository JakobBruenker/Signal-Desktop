// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Entry point of the browser UI build (bundles/browser/app.js). Renders the
// regular app from a replica of the headless backend's redux store:
//
// - The backend streams a snapshot, then every action its reducers see.
//   They're applied here with the same reducers, in order.
// - Nothing changes the replica locally. Action creators called by the UI
//   run on the backend (see backendClient.dom.ts) and their effects arrive
//   through the stream like everything else.

// Must come first: other modules read these globals when they load
import './browserGlobals.preload.ts';
import '../../windows/context.sandbox.ts';
// window.getVersion & co, window.IPC (its ipcRenderer calls reach the
// backend's main process through the electron shim)
import '../../windows/main/phase1-ipc.preload.ts';

import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { Middleware, Store, UnknownAction } from 'redux';
import { applyMiddleware, createStore } from 'redux';

import { reducer } from '../../state/reducer.preload.ts';
import type { StateType } from '../../state/reducer.preload.ts';
import { actionCreators } from '../../state/actions.preload.ts';
import { createApp } from '../../state/roots/createApp.preload.tsx';
import { restoreRemoteConfigFromStorage } from '../../RemoteConfig.std.ts';
import { decodeWire } from '../wire.std.ts';
import { callBackend, createRemoteActionBinder } from './backendClient.std.ts';
import { BrowserConversationController } from './conversationController.preload.ts';
import { startWindowStateReporting, tabId } from './windowState.dom.ts';
import { setRemoteActionBinder } from '../../hooks/useBoundActions.std.ts';
import { setLoadableUrlRewriter } from '../../util/toLoadableUrl.std.ts';
import { drop } from '../../util/drop.std.ts';

const REPLACE_STATE = '@@headless/REPLACE_STATE';
const REMOTE_ACTION = '@@headless/REMOTE_ACTION';

type AppAction = Parameters<typeof reducer>[1];

type ReplicaAction =
  | { type: typeof REPLACE_STATE; state: StateType }
  | { type: typeof REMOTE_ACTION; action: UnknownAction }
  | UnknownAction;

function replicaReducer(
  state: StateType | undefined,
  action: ReplicaAction
): StateType {
  if (action.type === REPLACE_STATE) {
    return (action as { state: StateType }).state;
  }
  if (action.type === REMOTE_ACTION) {
    return reducer(state, (action as { action: AppAction }).action);
  }
  // Local actions never touch the replica (see forwardLocalDispatch)
  return state ?? reducer(undefined, action as AppAction);
}

// Anything dispatched locally (useDispatch) is applied on the backend.
const forwardLocalDispatch: Middleware = () => next => action => {
  if (typeof action === 'function') {
    // oxlint-disable-next-line no-console
    console.error('Local thunk dispatch is not supported in the browser UI');
    return undefined;
  }
  const { type } = action as UnknownAction;
  if (type === REPLACE_STATE || type === REMOTE_ACTION) {
    return next(action);
  }
  drop(
    (async () => {
      try {
        await callBackend('/api/dispatch', { action });
      } catch (error) {
        // oxlint-disable-next-line no-console
        console.error(`dispatch ${type} failed`, error);
      }
    })()
  );
  return action;
};

// Values the backend can't send (see ReduxBridge) are recreated locally.
function withLocalValues(state: StateType): StateType {
  return {
    ...state,
    user: { ...state.user, i18n: window.SignalContext.i18n },
  };
}

// attachment:, emoji: and asset: URLs load through the backend's handlers
const LOCAL_SCHEMES = /^(attachment|emoji|asset):/;
const toServerUrl = (url: string) => `/proto?url=${encodeURIComponent(url)}`;
setLoadableUrlRewriter(toServerUrl);

// ...including those the backend put in redux state (avatarUrl, ...)
function reviveUrls(key: string, value: string): string {
  return /url$/i.test(key) && LOCAL_SCHEMES.test(value)
    ? toServerUrl(value)
    : value;
}

const bindActions = createRemoteActionBinder(actionCreators);
setRemoteActionBinder(bindActions);
window.reduxActions = Object.fromEntries(
  Object.entries(actionCreators).map(([duck, actions]) => [
    duck,
    bindActions(actions),
  ])
) as typeof window.reduxActions;

// Replaces the (empty) one phase1-ipc created
const conversationController = BrowserConversationController.create();
window.ConversationController =
  conversationController as unknown as typeof window.ConversationController;

type ConversationAttributesById = Readonly<
  Record<string, Readonly<Record<string, unknown>>>
>;

let store: Store<StateType> | undefined;
let root: Root | undefined;

// Module-level state the backend initializes during startup, mirrored from
// the replica store.
let lastRemoteConfig: unknown;
function syncModuleState(state: StateType): void {
  if (state.items.remoteConfig !== lastRemoteConfig) {
    lastRemoteConfig = state.items.remoteConfig;
    restoreRemoteConfigFromStorage({
      storage: {
        get: key => state.items[key],
        // Only get() is used when restoring
        put: async () => {
          throw new Error('read-only');
        },
        remove: async () => {
          throw new Error('read-only');
        },
      },
    });
  }
}

function render(currentStore: Store<StateType>): void {
  const container = document.getElementById('app-container');
  if (!container) {
    throw new Error('No #app-container');
  }
  root ??= createRoot(container);
  root.render(createApp(currentStore));
}

function connect(): void {
  const events = new EventSource(`/api/events?tab=${tabId}`);
  let seq = -1;

  events.addEventListener('snapshot', event => {
    const snapshot = decodeWire(event.data, reviveUrls) as {
      seq: number;
      state: StateType;
      conversationAttributes: ConversationAttributesById;
      signalConversationId?: string;
    };
    seq = snapshot.seq;
    conversationController.reset(
      snapshot.conversationAttributes,
      snapshot.signalConversationId
    );
    const state = withLocalValues(snapshot.state);
    if (store) {
      store.dispatch({ type: REPLACE_STATE, state });
      return;
    }
    const newStore = createStore(
      replicaReducer,
      state,
      applyMiddleware(forwardLocalDispatch)
    );
    store = newStore;
    window.reduxStore = newStore;
    syncModuleState(newStore.getState());
    newStore.subscribe(() => syncModuleState(newStore.getState()));
    render(newStore);
    startWindowStateReporting();
  });

  events.addEventListener('action', event => {
    const message = decodeWire(event.data, reviveUrls) as {
      seq: number;
      action: UnknownAction;
      conversationAttributes?: ConversationAttributesById;
      removedConversationIds?: ReadonlyArray<string>;
    };
    if (!store || message.seq !== seq + 1) {
      // Missed something: start over with a fresh snapshot
      // oxlint-disable-next-line no-console
      console.warn('event stream gap; resyncing', seq, message.seq);
      events.close();
      connect();
      return;
    }
    seq = message.seq;
    // Models first: rendering after the action may read them
    if (message.conversationAttributes || message.removedConversationIds) {
      conversationController.update(
        message.conversationAttributes ?? {},
        message.removedConversationIds ?? []
      );
    }
    store.dispatch({ type: REMOTE_ACTION, action: message.action });
  });
}

connect();
