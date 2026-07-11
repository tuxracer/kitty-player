import type { ScreenRegion } from 'kitty-motion';

import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';

/**
 * Structural subset of kitty-motion's Screen that the player uses, so tests
 * can pass a plain fake without casts.
 */
export interface PlayerScreen {
  getPlaceholderRows(): string[];
  pushFrame(frame: Uint8Array): void;
  setRegion(region: ScreenRegion): void;
  isWritable(): boolean;
  dispose(): void;
}

export interface VideoTimeUpdateEvent {
  /** Playhead position in seconds */
  currentTime: number;
  /** Total duration in seconds */
  duration: number;
}

export interface VideoLoadedMetadataEvent {
  /** Source frame width in pixels */
  videoWidth: number;
  /** Source frame height in pixels */
  videoHeight: number;
  /** Total duration in seconds */
  duration: number;
}

export interface PlaybackCallbacks {
  onTimeUpdate?: (event: VideoTimeUpdateEvent) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onError?: (error: unknown) => void;
}

export interface PlaybackClockOptions extends PlaybackCallbacks {
  /** null until managed resources are ready (self-managed mode) */
  screen: PlayerScreen | null;
  source: FrameSource | null;
  info: FrameSourceInfo | null;
  /** Start the clock immediately */
  autoPlay: boolean;
  /** Wrap at the end instead of stopping */
  loop: boolean;
  /** Write the one-time stderr note on frame errors (external mode only) */
  stderrNote: boolean;
}

export interface PlaybackClock {
  playing: boolean;
  /** Whole-second mirror of the playhead, drives Ink redraws */
  elapsedMs: number;
  ended: boolean;
  play(): void;
  pause(): void;
  togglePlay(): void;
  seekToMs(targetMs: number): void;
  /** The playhead ref value, fresh at any time (state above lags by design) */
  getElapsedMs(): number;
  /** Re-push the current frame (after region changes) */
  repaint(): void;
  noteSourceError(error: unknown): void;
}

export interface PlayerProps extends PlaybackCallbacks {
  screen: PlayerScreen;
  source: FrameSource;
  info: FrameSourceInfo;
  /** Start playback on mount (HTML5 default: off) */
  autoPlay?: boolean;
  /** Wrap to the start at the end instead of stopping (HTML5 default: off) */
  loop?: boolean;
  onLoadedMetadata?: (event: VideoLoadedMetadataEvent) => void;
}
