import type { RenderMode } from 'kitty-motion';
import type { AudioPlayer } from '../audioPlayer/index.ts';
import type {
  AudioVisualMode,
  AudioVisualSelection,
  OpenAudioVisualOptions,
} from '../audioVisual/index.ts';
import type { FfmpegSourceOptions } from '../ffmpegSource/index.ts';
import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';
import type { MediaProbeResult } from '../mediaProbe/index.ts';
import { AUDIO_VISUAL_MODES, RENDER_MODES } from './consts.ts';

/** Play a video file, or the built-in procedural demo when file is absent */
export interface PlayAction {
  action: 'play';
  /** Path of the video file to play (the positional argument) */
  file?: string;
  /** Skip terminal detection and play with the fallback cell renderer (--fallback) */
  fallback: boolean;
  /** Forced render mode (--render-mode). kitty forces the full player, cell modes force the fallback player */
  renderMode?: RenderMode;
  /** Start playback with audio muted (--muted) */
  muted: boolean;
  /** Visual used for audio-only files (--visual) */
  visual: AudioVisualMode;
}

/** True when value is one of kitty-motion's render mode names */
export const isRenderMode = (value: unknown): value is RenderMode =>
  typeof value === 'string' && RENDER_MODES.includes(value as RenderMode);

/** True when value is one of the audio-only visual mode names */
export const isAudioVisualMode = (value: unknown): value is AudioVisualMode =>
  typeof value === 'string' && AUDIO_VISUAL_MODES.includes(value as AudioVisualMode);

/** Print HELP_TEXT to stdout and exit 0 (--help / -h) */
export interface HelpAction {
  action: 'help';
}

/** Print VERSION to stdout and exit 0 (--version / -v) */
export interface VersionAction {
  action: 'version';
}

/** An unknown or malformed flag. The parseArgs message is printed with the usage text, exit 1. */
export interface UsageErrorAction {
  action: 'usage-error';
  /** The parseArgs error message describing the bad flag */
  message: string;
}

/** Discriminated union of everything a CLI invocation can ask for */
export type ParsedCliArgs = PlayAction | HelpAction | VersionAction | UsageErrorAction;

/** Why the kitty-graphics player cannot run in this terminal */
export type FallbackReason = 'no-placeholder-support' | 'multiplexed-session';

/** Where the loading indicator writes (process.stderr in production, a capture in tests) */
export interface LoadingIndicatorOutput {
  /** True animates the spinner line, false/absent prints one plain notice */
  isTTY?: boolean;
  write(text: string): unknown;
}

/** Handle returned by startLoadingIndicator */
export interface LoadingIndicator {
  /** Cancels the pending indicator and erases the spinner line if one was drawn. Idempotent. */
  stop(): void;
}

/** Streams for the fallback confirmation prompt (stdin/stderr in production) */
export interface ConfirmFallbackOptions {
  /** Where the answer line is read from */
  input: NodeJS.ReadableStream;
  /** Where the prompt text is written */
  output: NodeJS.WritableStream;
  /** The [y/N] question text written to output before reading the answer */
  prompt: string;
}

export interface OpenMediaSourceOptions {
  /** Path or http(s) URL of the media file */
  filePath: string;
  /** Classification from probeMediaFile, decides which source plays the file */
  probe: MediaProbeResult;
  /** Injectable factory for video files (createFfmpegSource in production) */
  createVideoSource?: (options: FfmpegSourceOptions) => FrameSource;
}

export interface OpenedMediaSource {
  /** The opened source, ready for getFrameAt */
  source: FrameSource;
  /** The stream info its open() resolved */
  info: FrameSourceInfo;
}

export type CliMediaPlayback =
  | { kind: 'procedural'; source: FrameSource; info: FrameSourceInfo }
  | { kind: 'video'; source: FrameSource; info: FrameSourceInfo; audio: AudioPlayer | null }
  | { kind: 'audio-visual'; source: FrameSource; info: FrameSourceInfo; audio: AudioPlayer | null }
  | { kind: 'audio-only'; durationMs: number; audio: AudioPlayer | null; label: string | null };

export interface ResolveMediaPlaybackOptions {
  /** Undefined selects the built-in procedural source */
  filePath?: string;
  visual: AudioVisualMode;
  /** Existing classification promise. Null is used for procedural playback. */
  probe: Promise<MediaProbeResult> | null;
  /** Existing fail-to-silent opened audio promise */
  audio: Promise<AudioPlayer | null>;
  createProceduralSource?: () => FrameSource;
  openVideo?: (options: OpenMediaSourceOptions) => Promise<OpenedMediaSource>;
  openVisual?: (options: OpenAudioVisualOptions) => Promise<AudioVisualSelection>;
}

export type CliPlaybackRoute =
  | { kind: 'audio-only'; fallback: boolean }
  | {
      kind: 'visual';
      forceKitty: boolean;
      fallbackMode?: RenderMode;
      reasons: FallbackReason[];
    };

export interface ResolvePlaybackRouteOptions {
  playback: CliMediaPlayback;
  fallback: boolean;
  renderMode?: RenderMode;
  detectReasons?: () => FallbackReason[];
  resolveFallbackMode?: (forcedMode?: RenderMode) => Promise<RenderMode>;
}
