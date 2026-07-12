import type { RenderMode } from 'kitty-motion';
import { RENDER_MODES } from './consts.ts';

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
}

/** True when value is one of kitty-motion's render mode names */
export const isRenderMode = (value: unknown): value is RenderMode =>
  typeof value === 'string' && RENDER_MODES.includes(value as RenderMode);

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

/** Streams for the fallback confirmation prompt (stdin/stderr in production) */
export interface ConfirmFallbackOptions {
  /** Where the answer line is read from */
  input: NodeJS.ReadableStream;
  /** Where the prompt text is written */
  output: NodeJS.WritableStream;
  /** The [y/N] question text written to output before reading the answer */
  prompt: string;
}
