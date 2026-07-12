export interface AudioPlayerInfo {
  /** False when the file has no audio stream or no output device exists, every other call is then a no-op */
  hasAudio: boolean;
}

export interface AudioPlayer {
  /** Probes the file and opens the audio device. Must be called before any other method. */
  open(): Promise<AudioPlayerInfo>;
  /**
   * Starts (or restarts) audible playback from timeMs. Covers play,
   * seek-while-playing, loop-around, and drift resync.
   */
  playFrom(timeMs: number): void;
  /** Stops audible output. Covers pause, seek-while-paused, and ended. */
  pause(): void;
  /** Silences output without stopping the decode or position tracking */
  setMuted(muted: boolean): void;
  /**
   * Current audible position in ms (the playFrom offset plus audio actually
   * delivered to the device), or null when not playing. Drives the clock's
   * drift correction.
   */
  getPositionMs(): number | null;
  /** Releases the decoder and the audio device. Idempotent. */
  close(): Promise<void>;
}
