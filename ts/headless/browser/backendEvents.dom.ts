// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Backend events that aren't redux state: notifications, sounds and the
// unread badge count (shown in the tab title and favicon).

import { drop } from '../../util/drop.std.ts';
import { decodeWire } from '../wire.std.ts';
import { callBackend } from './backendClient.std.ts';

const FAVICON_SRC = '/static/images/signal-logo-desktop-linux.png';
const FAVICON_SIZE = 64;

type NotificationEvent = Readonly<{
  id: string;
  title: string;
  body?: string;
  icon?: string;
  tag?: string;
}>;

type SoundEvent = Readonly<{ id: string; src: string; loop: boolean }>;

// ---- Notifications

const shown = new Map<string, Notification>();

// Browsers only allow asking in response to a user action
function requestPermissionOnFirstInteraction(): void {
  if (!('Notification' in window) || Notification.permission !== 'default') {
    return;
  }
  const ask = () => {
    document.removeEventListener('click', ask, true);
    document.removeEventListener('keydown', ask, true);
    drop(Notification.requestPermission());
  };
  document.addEventListener('click', ask, true);
  document.addEventListener('keydown', ask, true);
}

function showNotification(
  data: NotificationEvent,
  toLoadableUrl: (url: string) => string
): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }
  const notification = new Notification(data.title, {
    body: data.body,
    icon: data.icon ? toLoadableUrl(data.icon) : undefined,
    // Same tag in every tab, so only one of them stays visible
    tag: data.id,
    // The backend plays Signal's sound (see 'sound' events)
    silent: true,
  });
  notification.onclick = () => {
    window.focus();
    notification.close();
    drop(callBackend('/api/notification', { id: data.id, action: 'click' }));
  };
  notification.onclose = () => {
    shown.delete(data.id);
  };
  shown.set(data.id, notification);
}

// ---- Sounds

const playing = new Map<string, HTMLAudioElement>();

async function playSound({ id, src, loop }: SoundEvent): Promise<void> {
  // With several tabs open, only one plays it
  const play = async () => {
    const audio = new Audio(src);
    audio.loop = loop;
    playing.set(id, audio);
    try {
      await audio.play();
    } catch {
      // Autoplay blocked until the page has been interacted with
      playing.delete(id);
      return;
    }
    await new Promise<void>(resolve => {
      audio.addEventListener('ended', () => resolve());
      audio.addEventListener('pause', () => resolve());
    });
    playing.delete(id);
  };
  if (navigator.locks) {
    await navigator.locks.request(
      `signal-sound-${id}`,
      { ifAvailable: true },
      async lock => (lock ? play() : undefined)
    );
  } else {
    await play();
  }
}

function stopSound(id: string): void {
  playing.get(id)?.pause();
  playing.delete(id);
}

// ---- Unread badge

let faviconImage: HTMLImageElement | undefined;

function getFaviconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  return link;
}

function drawFavicon(count: number): void {
  const link = getFaviconLink();
  if (count <= 0) {
    link.href = FAVICON_SRC;
    return;
  }
  const image = faviconImage;
  if (!image?.complete) {
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  context.drawImage(image, 0, 0, FAVICON_SIZE, FAVICON_SIZE);

  const text = count > 99 ? '99+' : String(count);
  const radius = FAVICON_SIZE * 0.3;
  const x = FAVICON_SIZE - radius;
  const y = radius;
  context.beginPath();
  context.arc(x, y, radius, 0, 2 * Math.PI);
  context.fillStyle = '#e51d0e';
  context.fill();
  context.fillStyle = '#ffffff';
  context.font = `bold ${text.length > 2 ? 18 : 26}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, x, y + 1);

  link.href = canvas.toDataURL('image/png');
}

let badgeCount = 0;

function setBadge(count: number): void {
  badgeCount = count;
  document.title = count > 0 ? `Signal (${count})` : 'Signal';
  drawFavicon(count);
}

// ---- Wiring

export function handleBackendEvents(
  events: EventSource,
  toLoadableUrl: (url: string) => string
): void {
  events.addEventListener('notification', event => {
    showNotification(
      decodeWire(event.data) as NotificationEvent,
      toLoadableUrl
    );
  });
  events.addEventListener('notification-close', event => {
    const { id } = decodeWire(event.data) as { id: string };
    shown.get(id)?.close();
    shown.delete(id);
  });
  events.addEventListener('sound', event => {
    drop(playSound(decodeWire(event.data) as SoundEvent));
  });
  events.addEventListener('sound-stop', event => {
    stopSound((decodeWire(event.data) as { id: string }).id);
  });
  events.addEventListener('badge', event => {
    setBadge((decodeWire(event.data) as { count: number }).count);
  });
}

export function initializeBackendEvents(): void {
  requestPermissionOnFirstInteraction();
  faviconImage = new Image();
  faviconImage.addEventListener('load', () => drawFavicon(badgeCount));
  faviconImage.src = FAVICON_SRC;
  getFaviconLink().href = FAVICON_SRC;
}
