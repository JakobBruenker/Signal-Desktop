// Copyright 2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ActionCreatorsMapObject } from 'redux';
import type { ThunkActionDispatch } from 'redux-thunk';
import { bindActionCreators } from 'redux';
import { useDispatch } from 'react-redux';
import { useMemo } from 'react';

export type BoundActionCreatorsMapObject<T extends ActionCreatorsMapObject> = {
  [Property in keyof T]: ThunkActionDispatch<T[Property]>;
};

type RemoteActionBinder = <T extends ActionCreatorsMapObject>(
  actions: T
) => BoundActionCreatorsMapObject<T>;

let remoteActionBinder: RemoteActionBinder | undefined;

// Headless browser UI (ts/headless/browser/start.preload.tsx): action
// creators run on the backend's store instead of being dispatched locally.
export function setRemoteActionBinder(binder: RemoteActionBinder): void {
  remoteActionBinder = binder;
}

export function useBoundActions<T extends ActionCreatorsMapObject>(
  actions: T
): BoundActionCreatorsMapObject<T> {
  const dispatch = useDispatch();

  return useMemo(() => {
    if (remoteActionBinder) {
      return remoteActionBinder(actions);
    }
    return bindActionCreators(actions, dispatch);
  }, [actions, dispatch]);
}
