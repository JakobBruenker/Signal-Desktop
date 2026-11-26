// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

// Headless backend replacement for ts/util/Sound.std.ts: there's no audio
// output here, so sounds (notification pops, ringtones) play in the
// connected browser tabs instead.

import { Sound as OriginalSound, SoundType } from '../../util/Sound.std.ts';
import type { SoundOpts } from '../../util/Sound.std.ts';

export { SoundType };
export type { SoundOpts };

let nextId = 1;

export class Sound {
  readonly #loop: boolean;
  readonly #soundType: SoundType;
  #playingId: string | undefined;

  constructor(options: SoundOpts) {
    this.#loop = Boolean(options.loop);
    this.#soundType = options.soundType;
  }

  async play(): Promise<void> {
    this.stop();
    const id = `sound-${nextId}`;
    nextId += 1;
    this.#playingId = id;
    window.SignalHeadless?.playSound({
      id,
      src: OriginalSound.getSrc(this.#soundType),
      loop: this.#loop,
    });
  }

  stop(): void {
    if (this.#playingId) {
      window.SignalHeadless?.stopSound(this.#playingId);
      this.#playingId = undefined;
    }
  }

  static getSrc(soundType: SoundType): string {
    return OriginalSound.getSrc(soundType);
  }
}
