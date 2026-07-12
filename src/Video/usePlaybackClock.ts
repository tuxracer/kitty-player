import { useCallback, useEffect, useRef, useState } from 'react';

import { MS_PER_SECOND } from './consts.ts';
import type { PlaybackClock, PlaybackClockOptions } from './types.ts';

/**
 * The playback pipeline shared by both Video modes. A setInterval at the
 * source frame rate lives outside React state. Refs mirror playing and
 * elapsed time as the source of truth for the interval callback, an
 * in-flight guard keeps async getFrameAt calls from piling up behind a slow
 * source, and React state (so an Ink redraw) updates only when the displayed
 * whole second changes. Resources may be null (self-managed mode before the
 * source opens), in which case the clock idles.
 */
export const usePlaybackClock = ({
  screen,
  source,
  info,
  autoPlay,
  loop,
  stderrNote,
  onTimeUpdate,
  onPlay,
  onPause,
  onEnded,
  onError,
}: PlaybackClockOptions): PlaybackClock => {
  const [playing, setPlaying] = useState(autoPlay);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [ended, setEnded] = useState(false);

  const playingRef = useRef(autoPlay);
  const elapsedRef = useRef(0);
  const endedRef = useRef(false);
  const inFlightRef = useRef(false);
  const sourceErrorNotedRef = useRef(false);

  // Callbacks live in a ref so a new inline-callback identity on a host
  // rerender never restarts the interval effect.
  const callbacksRef = useRef({ onTimeUpdate, onPlay, onPause, onEnded, onError });
  callbacksRef.current = { onTimeUpdate, onPlay, onPause, onEnded, onError };

  const noteSourceError = useCallback(
    (error: unknown): void => {
      callbacksRef.current.onError?.(error);
      if (stderrNote && !sourceErrorNotedRef.current) {
        sourceErrorNotedRef.current = true;
        process.stderr.write('kitty-video-player: frame source error, playback continues\n');
      }
    },
    [stderrNote],
  );

  // Fetch and display the frame at nextMs. Elapsed time always lands in the
  // ref, but React state (and onTimeUpdate) only fire when the displayed
  // whole second changes.
  const showFrameAt = useCallback(
    (nextMs: number): void => {
      if (inFlightRef.current || screen === null || source === null || info === null) {
        return;
      }
      inFlightRef.current = true;
      void source
        .getFrameAt(nextMs)
        .then((frame) => {
          if (frame) {
            screen.pushFrame(frame);
          }
          const previousSecond = Math.floor(elapsedRef.current / MS_PER_SECOND);
          const nextSecond = Math.floor(nextMs / MS_PER_SECOND);
          elapsedRef.current = nextMs;
          if (nextSecond !== previousSecond) {
            setElapsedMs(nextMs);
            callbacksRef.current.onTimeUpdate?.({
              currentTime: nextMs / MS_PER_SECOND,
              duration: info.durationMs / MS_PER_SECOND,
            });
          }
        })
        .catch(noteSourceError)
        .finally(() => {
          inFlightRef.current = false;
        });
    },
    [info, noteSourceError, screen, source],
  );

  const pause = useCallback((): void => {
    if (!playingRef.current) {
      return;
    }
    playingRef.current = false;
    setPlaying(false);
    callbacksRef.current.onPause?.();
  }, []);

  const play = useCallback((): void => {
    if (endedRef.current) {
      // HTML5 semantics: play() after ended restarts from the beginning
      endedRef.current = false;
      setEnded(false);
      elapsedRef.current = 0;
      setElapsedMs(0);
    }
    if (playingRef.current) {
      return;
    }
    playingRef.current = true;
    setPlaying(true);
    callbacksRef.current.onPlay?.();
  }, []);

  const togglePlay = useCallback((): void => {
    if (playingRef.current) {
      pause();
    } else {
      play();
    }
  }, [pause, play]);

  // A new source starts from zero (src/srcObject changes in managed mode).
  // Runs harmlessly on first mount, everything is already zero.
  useEffect(() => {
    elapsedRef.current = 0;
    setElapsedMs(0);
    endedRef.current = false;
    setEnded(false);
  }, [source]);

  // Playback loop. Deps are stable while resources are stable, so this is
  // effectively mount-only per resource set and survives every rerender.
  useEffect(() => {
    if (screen === null || source === null || info === null) {
      return;
    }
    showFrameAt(elapsedRef.current);
    const intervalMs = Math.round(MS_PER_SECOND / info.fps);
    const interval = setInterval(() => {
      if (!playingRef.current || !screen.isWritable() || inFlightRef.current) {
        return;
      }
      const nextMs = elapsedRef.current + intervalMs;
      if (nextMs < info.durationMs) {
        showFrameAt(nextMs);
        return;
      }
      if (loop) {
        showFrameAt(nextMs % info.durationMs);
        return;
      }
      // End of stream: park on the final frame, stop, and report. Elapsed
      // state is parked at duration synchronously here (not left to
      // showFrameAt's .then) so a host reading elapsed state inside onEnded
      // sees the playhead at the end, matching HTML5's currentTime ===
      // duration guarantee in the ended event. showFrameAt's .then still
      // runs for the final frame paint. It sees no second-crossing since
      // elapsedRef is already at durationMs, which is fine.
      showFrameAt(info.durationMs);
      elapsedRef.current = info.durationMs;
      setElapsedMs(info.durationMs);
      playingRef.current = false;
      setPlaying(false);
      endedRef.current = true;
      setEnded(true);
      callbacksRef.current.onPause?.();
      callbacksRef.current.onEnded?.();
    }, intervalMs);
    return () => {
      clearInterval(interval);
    };
  }, [info, loop, screen, showFrameAt, source]);

  const seekToMs = useCallback(
    (targetMs: number): void => {
      if (source === null || info === null) {
        return;
      }
      const clampedMs = Math.min(Math.max(targetMs, 0), info.durationMs);
      endedRef.current = false;
      setEnded(false);
      void source
        .seek(clampedMs)
        .then(() => {
          showFrameAt(clampedMs);
        })
        .catch(noteSourceError);
    },
    [info, noteSourceError, showFrameAt, source],
  );

  const getElapsedMs = useCallback((): number => elapsedRef.current, []);

  const repaint = useCallback((): void => {
    showFrameAt(elapsedRef.current);
  }, [showFrameAt]);

  return {
    playing,
    elapsedMs,
    ended,
    play,
    pause,
    togglePlay,
    seekToMs,
    getElapsedMs,
    repaint,
    noteSourceError,
  };
};
