import { parseArgs } from 'node:util';

import { AUDIO_VISUAL_MODES, RENDER_MODES } from './consts.ts';
import { isAudioVisualMode, isRenderMode } from './types.ts';
import type { ParsedCliArgs, PlayAction } from './types.ts';

/**
 * Pure argv parser for the CLI. It lives in its own file rather than in
 * index.tsx because the entry runs the player at module top level, so tests
 * import the parser from here without executing the entry (index.tsx
 * re-exports it for completeness).
 *
 * One positional argument selects the video file to play; more than one is a
 * usage error naming the extras.
 *
 * Unknown or malformed flags make parseArgs throw. The error is caught and
 * surfaced as a usage-error action carrying the message, so the caller can
 * print it alongside the usage text and exit nonzero instead of crashing
 * with a stack trace.
 */
export const parseCliArgs = (argv: string[]): ParsedCliArgs => {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        fallback: { type: 'boolean' },
        muted: { type: 'boolean' },
        visual: { type: 'string' },
        'render-mode': { type: 'string' },
      },
    });
    if (values.help) {
      return { action: 'help' };
    }
    if (values.version) {
      return { action: 'version' };
    }
    const renderModeValue = values['render-mode'];
    if (renderModeValue !== undefined && !isRenderMode(renderModeValue)) {
      return {
        action: 'usage-error',
        message: `invalid --render-mode "${renderModeValue}" (valid modes: ${RENDER_MODES.join(', ')})`,
      };
    }
    const visualValue = values.visual;
    if (visualValue !== undefined && !isAudioVisualMode(visualValue)) {
      return {
        action: 'usage-error',
        message: `invalid --visual "${visualValue}" (valid modes: ${AUDIO_VISUAL_MODES.join(', ')})`,
      };
    }
    if (positionals.length > 1) {
      return {
        action: 'usage-error',
        message: `unexpected extra arguments: ${positionals.slice(1).join(' ')}`,
      };
    }
    const play: PlayAction = {
      action: 'play',
      fallback: values.fallback === true,
      muted: values.muted === true,
      visual: visualValue ?? 'auto',
    };
    if (positionals.length === 1) {
      play.file = positionals[0];
    }
    if (renderModeValue !== undefined && isRenderMode(renderModeValue)) {
      play.renderMode = renderModeValue;
    }
    return play;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { action: 'usage-error', message };
  }
};
