import {
  detectCellRenderMode,
  detectKittyGraphicsSupport,
  isMultiplexedSession,
  Screen,
} from 'kitty-motion';
import type { RenderMode } from 'kitty-motion';

import type { FrameSourceInfo } from '../frameSource/index.ts';
import { DRIFT_RESYNC_THRESHOLD_MS, SEEK_STEP_MS } from '../Video/index.tsx';
import {
  KEY_ARROW_LEFT,
  KEY_ARROW_RIGHT,
  KEY_CTRL_C,
  KEY_MUTE,
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
 * to pushFrame, and the same buffering gate holding the clock and audio at
 * startup, seeks, and wraps until the source delivers the gated frame),
 * always autoplay and always loop, matching what the cli passes to Video. Keys come from a raw stdin data listener. Resolves when
 * the user quits, after the screen is disposed and the source is closed.
 */
export const runFallbackPlayer = ({
  screen,
  source,
  info,
  input,
  audio = null,
  muted = false,
}: FallbackPlayerOptions): Promise<void> =>
  new Promise((resolve) => {
    let playing = true;
    let elapsedMs = 0;
    let inFlight = false;
    let sourceErrorNoted = false;
    let audioMuted = muted;
    let lastDriftSecond = 0;
    // The buffering gate and its timeline, mirroring usePlaybackClock: the
    // playhead holds until the source delivers the frame at the gated
    // position and the audio started there has made sound or reported it
    // cannot, so picture and sound begin together. A bumped timeline keeps
    // a fetch from before a seek from writing its timestamp over the new
    // position, and audioStarted makes each hold start audio exactly once.
    let waiting = true;
    let audioStarted = false;
    let timeline = 0;
    // Wall-clock anchor, reset at every gate release: ticks compute the
    // playhead from real elapsed time instead of counting intervals, whose
    // lost lateness would drag the clock behind the audio (see
    // usePlaybackClock).
    let anchorWallMs = 0;
    let anchorElapsedMs = 0;
    const intervalMs = Math.round(MS_PER_SECOND / info.fps);
    audio?.setMuted(audioMuted);

    const noteSourceError = (): void => {
      if (!sourceErrorNoted) {
        sourceErrorNoted = true;
        process.stderr.write('kitty-media-player: frame source error, playback continues\n');
      }
    };

    const showFrameAt = (nextMs: number): void => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      const fetchTimeline = timeline;
      void source
        .getFrameAt(nextMs)
        .then((frame) => {
          if (frame) {
            screen.pushFrame(frame);
          }
          if (timeline !== fetchTimeline) {
            // A seek or wrap superseded this fetch, keep the new position
            return;
          }
          if (waiting) {
            if (!frame) {
              // Still buffering: hold the playhead until the frame lands
              return;
            }
            // The picture is ready. Start audio at the position the
            // picture resumed from (once per hold), then keep holding
            // until the source's readahead is comfortably full and the
            // audio has made sound or reports it cannot.
            if (!audioStarted && playing) {
              audioStarted = true;
              audio?.playFrom(nextMs);
            }
            if (source.isBuffering?.() ?? false) {
              return;
            }
            if (playing && (audio?.isStarting() ?? false)) {
              return;
            }
            waiting = false;
            anchorWallMs = Date.now();
            anchorElapsedMs = nextMs;
          }
          elapsedMs = nextMs;
        })
        .catch(noteSourceError)
        .finally(() => {
          inFlight = false;
        });
    };

    // Synchronous playhead move shared by seeks and wraps: bump the
    // timeline and gate the clock on the frame at the target. Audio
    // restarts through the gate, not here.
    const movePlayheadTo = (targetMs: number): void => {
      timeline += 1;
      waiting = true;
      audioStarted = false;
      elapsedMs = targetMs;
    };

    const seekToMs = (targetMs: number): void => {
      const clampedMs = Math.min(Math.max(targetMs, 0), info.durationMs);
      movePlayheadTo(clampedMs);
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
      if (waiting && elapsedMs + intervalMs < info.durationMs) {
        // Buffering: retry the gated position instead of advancing. At the
        // end of the stream this falls through so a gated playhead parked
        // there still reaches the wrap below.
        showFrameAt(elapsedMs);
        return;
      }
      const nextMs = waiting
        ? elapsedMs + intervalMs
        : anchorElapsedMs + (Date.now() - anchorWallMs);
      if (nextMs < info.durationMs) {
        // Drift snap once per whole second, on non-wrap ticks only, so a
        // wrap tick never fires a redundant snap right before its own
        // restart. The resync goes through the gate (hold at the playhead,
        // restart audio there, release when audible), so a slow-starting
        // decoder is never respawned into a chase it cannot win.
        const second = Math.floor(elapsedMs / MS_PER_SECOND);
        if (second !== lastDriftSecond) {
          lastDriftSecond = second;
          const audioPositionMs = audio?.getPositionMs() ?? null;
          if (audioPositionMs !== null && Math.abs(audioPositionMs - elapsedMs) > DRIFT_RESYNC_THRESHOLD_MS) {
            waiting = true;
            audioStarted = false;
            showFrameAt(elapsedMs);
            return;
          }
        }
        showFrameAt(nextMs);
        return;
      }
      // Always loop, wrapping like usePlaybackClock's loop branch. The
      // gate restarts audio when the wrapped frame paints, so realign the
      // drift tracker to the wrapped second instead of letting the
      // post-wrap second change trigger a spurious check.
      const wrappedMs = nextMs % info.durationMs;
      lastDriftSecond = Math.floor(wrappedMs / MS_PER_SECOND);
      movePlayheadTo(wrappedMs);
      showFrameAt(wrappedMs);
    }, intervalMs);

    const quit = (): void => {
      clearInterval(interval);
      input.off('data', onKey);
      input.setRawMode?.(false);
      input.pause?.();
      screen.dispose();
      void Promise.all([
        source.close(),
        audio === null ? Promise.resolve() : audio.close(),
      ])
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
          if (playing) {
            // Resume goes through the gate like every other start: hold
            // until the audio restarted at the playhead is audible,
            // kicked immediately so a local resume clears within a frame
            // fetch instead of a full tick. While the gate already holds,
            // it owns the start.
            if (!waiting) {
              waiting = true;
              audioStarted = false;
              showFrameAt(elapsedMs);
            }
          } else {
            audio?.pause();
            // A held gate must issue a fresh audio start on resume, the
            // paused one was killed
            audioStarted = false;
          }
        }
        if (key === KEY_MUTE) {
          audioMuted = !audioMuted;
          audio?.setMuted(audioMuted);
        }
        i += 1;
      }
    };

    input.setRawMode?.(true);
    input.resume?.();
    input.on('data', onKey);
  });
