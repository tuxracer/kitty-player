import type { FallbackReason } from './types.ts';
import type { RenderMode } from 'kitty-motion';

/**
 * Package version printed by --version. Kept as a literal because importing
 * package.json from outside src/ breaks the tsconfig include. Keep in sync
 * with the "version" field in package.json.
 */
export const VERSION = '0.3.0';

/** Values accepted by --render-mode, kitty-motion's full RenderMode union */
export const RENDER_MODES: readonly RenderMode[] = [
  'kitty',
  'half-block',
  'cell-background',
  'emoji',
  'ascii',
];

/** Exit code for success paths (help, version, graceful unsupported-terminal exit) */
export const EXIT_OK = 0;

/** Exit code for usage errors and unplayable files */
export const EXIT_USAGE = 1;

/** Usage and controls text printed by --help (and to stderr after a usage error) */
export const HELP_TEXT = `kitty-media-player, a terminal media player (Ink UI with a kitty-motion video panel)

Usage:
  kitty-media-player            play the built-in procedural demo
  kitty-media-player <file>     play a video or audio file (decoded with the bundled ffmpeg)
  kitty-media-player <url>      play media from an http(s) URL

Options:
  -h, --help              print this help and exit
  -v, --version           print the version and exit
      --fallback          play without the Ink UI using the best available
                          renderer (kitty graphics without controls when
                          the terminal supports them, otherwise a cell
                          renderer)
      --muted             start playback with audio muted (the m key
                          toggles it back)
      --render-mode <mode>
                          force a render mode: kitty, half-block,
                          cell-background, emoji, or ascii. kitty alone
                          forces the full player, cell modes force the
                          fallback player, and --fallback --render-mode
                          kitty forces kitty graphics without controls

Controls:
  space                   play or pause
  left/right arrow        seek 5 seconds
  m                       mute or unmute audio
  q or Ctrl-C             quit
  (the same keys work in fallback mode, there is just no on-screen UI)

Audio files (mp3, ogg, flac, and anything else ffmpeg decodes) play with
their embedded cover art when they have one, or a live waveform when they
do not.

The full player requires an interactive Kitty or Ghostty terminal (Kitty
graphics protocol with Unicode placeholder support) outside tmux/screen.
On other terminals kitty-media-player offers to play without on-screen controls,
using kitty graphics when the terminal supports them (iTerm2 for example)
or a fallback cell renderer (cell-background on Terminal.app, half-block
elsewhere).`;

/** Printed to stderr when stdout is not an interactive terminal */
export const UNSUPPORTED_TERMINAL_MESSAGE =
  'kitty-media-player needs an interactive terminal (stdout is not a TTY). Nothing was drawn.';

/** First line of the warning printed before the fallback prompt */
export const FALLBACK_WARNING_HEADER = 'kitty-media-player: the full player cannot run here:';

/** One warning line per fallback reason, printed under FALLBACK_WARNING_HEADER */
export const FALLBACK_REASON_MESSAGES: Record<FallbackReason, string> = {
  'no-placeholder-support':
    'this terminal does not support kitty graphics with Unicode placeholders',
  'multiplexed-session':
    'tmux or GNU screen is intercepting the kitty graphics escape sequences',
};

/** The [y/N] question printed after the fallback warning lines */
export const FALLBACK_PROMPT =
  'Continue in fallback mode (reduced quality, no on-screen UI)? [y/N] ';

/** The [y/N] question used when the fallback can use full-quality kitty graphics */
export const FALLBACK_PROMPT_KITTY =
  'Continue with kitty graphics (full quality, no on-screen UI)? [y/N] ';

/** Extra line after the reason lines when kitty graphics work but placeholders do not */
export const FALLBACK_KITTY_NOTE =
  'kitty graphics work here, but without Unicode placeholder support the on-screen controls cannot be drawn';

/** Answers that accept the fallback prompt, compared trimmed and lowercased */
export const FALLBACK_YES_ANSWERS: readonly string[] = ['y', 'yes'];

/** Loading spinner frames, the same dots animation @inkjs/ui's Spinner renders inside Ink */
export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Milliseconds between loading spinner frames (matches @inkjs/ui's dots timing) */
export const SPINNER_INTERVAL_MS = 80;

/** Carriage return plus erase-to-end-of-line, removes the spinner line on stop */
export const CLEAR_LINE = '\r\u001B[2K';
