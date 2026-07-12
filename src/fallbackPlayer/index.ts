import {
  detectCellRenderMode,
  detectKittyGraphicsSupport,
  isMultiplexedSession,
  Screen,
} from 'kitty-motion';
import type { RenderMode } from 'kitty-motion';

import type { FrameSourceInfo } from '../frameSource/index.ts';
import { SEEK_STEP_MS } from '../Video/index.tsx';
import {
  KEY_ARROW_LEFT,
  KEY_ARROW_RIGHT,
  KEY_CTRL_C,
  KEY_QUIT,
  KEY_SPACE,
  MS_PER_SECOND,
} from './consts.ts';
import type { FallbackPlayerOptions, ResolveFallbackRenderModeOptions } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

/**
 * Pick the fallback player's render mode. A forced mode wins untouched,
 * which keeps --fallback --render-mode kitty usable inside tmux with
 * allow-passthrough. Otherwise a multiplexed session (tmux or GNU screen)
 * resolves straight to the auto-detected cell mode without probing, because
 * the multiplexer swallows the graphics escapes even when the outer terminal
 * is kitty and the probe's environment fast path would report support.
 * Outside a multiplexer the kitty graphics probe decides. Terminals like
 * iTerm2 implement the graphics protocol without Unicode placeholders, so
 * they get full-quality kitty rendering (only the Ink controls need
 * placeholders). When the probe fails the auto-detected cell mode is used
 * (cell-background on Terminal.app, half-block elsewhere). The probe reads
 * stdin, so this must run before Ink takes stdin over.
 */
export const resolveFallbackRenderMode = async (
  forced?: RenderMode,
  {
    probeKittyGraphics = detectKittyGraphicsSupport,
    detectCellMode = detectCellRenderMode,
    isMultiplexed = isMultiplexedSession,
  }: ResolveFallbackRenderModeOptions = {},
): Promise<RenderMode> => {
  if (forced !== undefined) {
    return forced;
  }
  if (isMultiplexed()) {
    return detectCellMode();
  }
  return (await probeKittyGraphics()) ? 'kitty' : detectCellMode();
};

/**
 * Construct the fallback Screen synchronously and probe-free, the same trick
 * as the Video module's managedScreen. The caller resolves the render mode
 * first (resolveFallbackRenderMode), so the Screen never sees undefined,
 * which matters because probe-free construction with an undefined renderMode
 * would follow a probe cache that selects kitty. The mode may be kitty
 * itself (full quality at the default cursor placement, for terminals like
 * iTerm2 with graphics but no placeholders) or a cell mode. fileTransfer
 * false and dirtyRects false skip the remaining probes. Runs in full-screen
 * destructive mode, so kitty-motion clears the screen, fits and centers the
 * frame, follows terminal resizes via autoResize, and restores the terminal
 * on dispose.
 */
export const createFallbackScreen = (info: FrameSourceInfo, renderMode: RenderMode): Screen =>
  new Screen({
    output: process.stdout,
    sourceWidth: info.width,
    sourceHeight: info.height,
    colorSpace: info.colorSpace,
    renderMode,
    fileTransfer: false,
    dirtyRects: false,
    embedded: false,
    autoResize: true,
  });

/**
 * Playback loop for cell-renderer fallback mode. There is no Ink here because
 * the cell renderer writes cells directly and produces no placeholder
 * rows, so there is nothing for Ink to lay out. This is a plain-function port of
 * usePlaybackClock's behavior (a setInterval at the source frame rate, an
 * in-flight guard so async getFrameAt calls never pile up, frames straight
 * to pushFrame), always autoplay and always loop, matching what the cli
 * passes to Video. Keys come from a raw stdin data listener. Resolves when
 * the user quits, after the screen is disposed and the source is closed.
 */
export const runFallbackPlayer = ({
  screen,
  source,
  info,
  input,
}: FallbackPlayerOptions): Promise<void> =>
  new Promise((resolve) => {
    let playing = true;
    let elapsedMs = 0;
    let inFlight = false;
    let sourceErrorNoted = false;
    const intervalMs = Math.round(MS_PER_SECOND / info.fps);

    const noteSourceError = (): void => {
      if (!sourceErrorNoted) {
        sourceErrorNoted = true;
        process.stderr.write('kitty-video-player: frame source error, playback continues\n');
      }
    };

    const showFrameAt = (nextMs: number): void => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      void source
        .getFrameAt(nextMs)
        .then((frame) => {
          if (frame) {
            screen.pushFrame(frame);
          }
          elapsedMs = nextMs;
        })
        .catch(noteSourceError)
        .finally(() => {
          inFlight = false;
        });
    };

    const seekToMs = (targetMs: number): void => {
      const clampedMs = Math.min(Math.max(targetMs, 0), info.durationMs);
      void source
        .seek(clampedMs)
        .then(() => {
          showFrameAt(clampedMs);
        })
        .catch(noteSourceError);
    };

    showFrameAt(0);
    const interval = setInterval(() => {
      if (!playing || !screen.isWritable() || inFlight) {
        return;
      }
      const nextMs = elapsedMs + intervalMs;
      // Always loop, wrapping like usePlaybackClock's loop branch
      showFrameAt(nextMs < info.durationMs ? nextMs : nextMs % info.durationMs);
    }, intervalMs);

    const quit = (): void => {
      clearInterval(interval);
      input.off('data', onKey);
      input.setRawMode?.(false);
      input.pause?.();
      screen.dispose();
      void source
        .close()
        .catch(noteSourceError)
        .finally(() => {
          resolve();
        });
    };

    // A single 'data' event can carry several keypresses (arrow auto-repeat
    // bursts, SSH batching), so scan the chunk instead of comparing it whole
    const onKey = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      let i = 0;
      while (i < text.length) {
        if (text.startsWith(KEY_ARROW_RIGHT, i)) {
          seekToMs(elapsedMs + SEEK_STEP_MS);
          i += KEY_ARROW_RIGHT.length;
          continue;
        }
        if (text.startsWith(KEY_ARROW_LEFT, i)) {
          seekToMs(elapsedMs - SEEK_STEP_MS);
          i += KEY_ARROW_LEFT.length;
          continue;
        }
        const key = text[i];
        if (key === KEY_QUIT || key === KEY_CTRL_C) {
          quit();
          return;
        }
        if (key === KEY_SPACE) {
          playing = !playing;
        }
        i += 1;
      }
    };

    input.setRawMode?.(true);
    input.resume?.();
    input.on('data', onKey);
  });
