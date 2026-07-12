import type { ColorSpace, ScreenRegion } from 'kitty-motion';
import type { ReactNode } from 'react';

import type { AudioPlayer } from '../audioPlayer/index.ts';
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
  /** Audio following the clock, or null/absent when the source has no audio */
  audio?: AudioPlayer | null;
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

export interface VideoRef {
  play(): Promise<void>;
  pause(): void;
  /** Playhead in seconds, get/set (setting seeks) */
  currentTime: number;
  readonly paused: boolean;
  readonly ended: boolean;
  /** Audio muted state, get/set (setting silences or restores the audio device) */
  muted: boolean;
  /** Duration in seconds, NaN before metadata loads */
  readonly duration: number;
  /** Source width in pixels, 0 before metadata loads */
  readonly videoWidth: number;
  /** Source height in pixels, 0 before metadata loads */
  readonly videoHeight: number;
}

export interface ManagedScreenOptions {
  region: ScreenRegion;
  sourceWidth: number;
  sourceHeight: number;
  colorSpace: ColorSpace;
}

export type ManagedStatus = 'unsupported' | 'loading' | 'error' | 'ready';

export interface ManagedResources {
  status: ManagedStatus;
  screen: PlayerScreen | null;
  source: FrameSource | null;
  info: FrameSourceInfo | null;
}

export interface ManagedResourcesOptions {
  /** False in external-resources mode, the hook then idles */
  enabled: boolean;
  /** Video file path, decoded with the bundled ffmpeg */
  src?: string;
  /** A FrameSource not yet opened, mirrors HTMLMediaElement.srcObject */
  srcObject?: FrameSource;
  /** Panel box width in terminal cells */
  width: number;
  /** Panel box height in terminal cells */
  height: number;
  onLoadedMetadata?: (event: VideoLoadedMetadataEvent) => void;
  onError?: (error: unknown) => void;
}

export type VideoErrorCode = 'INVALID_SRC';

export class VideoError extends Error {
  readonly code: VideoErrorCode;
  constructor(code: VideoErrorCode) {
    super(code);
    this.name = 'VideoError';
    this.code = code;
  }
}

export const isVideoError = (error: unknown): error is VideoError =>
  error instanceof VideoError;

export interface VideoBaseProps extends PlaybackCallbacks {
  /** Start playback on mount (HTML5 default: off) */
  autoPlay?: boolean;
  /** Wrap to the start at the end instead of stopping (HTML5 default: off) */
  loop?: boolean;
  /** Start with audio muted (HTML5 default: off). Toggle at runtime through the ref handle or the m key */
  muted?: boolean;
  /** Render the one-row progress/time bar below the video */
  controls?: boolean;
  /** Bind the CLI key set: space play/pause, arrows seek, q/ctrl-c quit */
  keyboard?: boolean;
  /** Render the title row above the video */
  title?: boolean;
  /** Render the help row below the controls */
  help?: boolean;
  /** Rendered when the terminal cannot display video, like <video> children */
  children?: ReactNode;
  onLoadedMetadata?: (event: VideoLoadedMetadataEvent) => void;
}

export interface ExternalVideoProps extends VideoBaseProps {
  /** Host-created Screen. Its presence selects external-resources mode */
  screen: PlayerScreen;
  /** An already-opened source, the host owns its lifecycle */
  source: FrameSource;
  info: FrameSourceInfo;
  /** An already-opened audio player, the host owns its lifecycle */
  audio?: AudioPlayer;
}

export interface ManagedVideoProps extends VideoBaseProps {
  screen?: undefined;
  /** Video file path, decoded with the bundled ffmpeg */
  src?: string;
  /** A FrameSource not yet opened, mirrors HTMLMediaElement.srcObject */
  srcObject?: FrameSource;
  /** Panel box width in terminal cells */
  width: number;
  /** Panel box height in terminal cells */
  height: number;
}

export type VideoProps = ExternalVideoProps | ManagedVideoProps;
