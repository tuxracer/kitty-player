import { useCallback, useEffect, useRef, useState } from 'react';

import { DRIFT_RESYNC_THRESHOLD_MS, MS_PER_SECOND } from './consts.ts';
import type { PlaybackClock, PlaybackClockOptions } from './types.ts';

/**
 * The playback pipeline shared by both Video modes. A setInterval at the
 * source frame rate lives outside React state. Refs mirror playing and
 * elapsed time as the source of truth for the interval callback, an
 * in-flight guard keeps async getFrameAt calls from piling up behind a slow
 * source, and React state (so an Ink redraw) updates only when the displayed
 * whole second changes. Resources may be null (self-managed mode before the
 * source opens), in which case the clock idles.
 *
 * A buffering gate holds the clock at startup, after seeks, loop wraps, and
 * replays: the playhead does not advance until the source delivers the
 * frame at the gated position, and then keeps holding until the audio
 * started there has made sound or reported it cannot (isStarting), so
 * picture and sound begin together. Remote URLs take seconds to produce
 * their first frame and their first audio, and without the gate the bar
 * runs ahead and the skipped content is never shown. Once playback is
 * underway a null frame still advances the clock (frames drop, playback
 * stays realtime).
 */
export const usePlaybackClock = ({
  screen,
  source,
  info,
  audio,
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
  const [buffering, setBuffering] = useState(true);

  const playingRef = useRef(autoPlay);
  const elapsedRef = useRef(0);
  const endedRef = useRef(false);
  const inFlightRef = useRef(false);
  const sourceErrorNotedRef = useRef(false);

  // Callbacks live in a ref so a new inline-callback identity on a host
  // rerender never restarts the interval effect.
  const callbacksRef = useRef({ onTimeUpdate, onPlay, onPause, onEnded, onError });
  callbacksRef.current = { onTimeUpdate, onPlay, onPause, onEnded, onError };

  // The audio player lives in a ref for the same reason the callbacks do:
  // play/pause/seek callbacks stay dependency-free across host rerenders.
  const audioRef = useRef(audio ?? null);
  audioRef.current = audio ?? null;

  // Reads playingRef through a function call because the re-checks after
  // host callbacks below would otherwise be narrowed away: TypeScript keeps
  // property narrowing across function calls, but an onPlay/onPause/onEnded
  // handler can synchronously re-enter the clock and flip the ref.
  const readPlaying = useCallback((): boolean => playingRef.current, []);

  // Bumped whenever the playhead is reset outside a frame fetch (seek,
  // replay after ended, loop wrap, source change). A fetch that started on
  // the old timeline still paints its frame, but must not write its
  // timestamp back into elapsedRef and clobber the reset.
  const timelineRef = useRef(0);

  // The buffering gate, two phases. Armed at startup, seeks, loop wraps,
  // replays, resumes, drift resyncs, and source changes. While armed the
  // interval retries the same position instead of advancing. Phase one
  // waits for the source to deliver the frame at the playhead. Phase two
  // starts audio there and keeps holding until the audio has made sound or
  // reported it cannot (isStarting), so picture and sound begin together.
  // The buffering state mirrors the ref for the UI's indicator.
  const waitingRef = useRef(true);

  // Whether the currently armed gate has already issued its audio start.
  // Reset whenever the gate re-arms or audio is paused, so every hold
  // starts audio exactly once.
  const audioStartedRef = useRef(false);

  const armGate = useCallback((): void => {
    waitingRef.current = true;
    audioStartedRef.current = false;
    setBuffering(true);
  }, []);

  // Wall-clock anchor for the running clock, reset at every gate release.
  // Ticks compute the playhead from real elapsed time instead of counting
  // intervals: a late timer fire permanently loses its lateness (one to
  // two percent under decode load), which would drag the clock behind an
  // accurately paced audio device and trip the drift snap forever.
  const anchorRef = useRef({ wallMs: 0, elapsedMs: 0 });

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
      const timeline = timelineRef.current;
      void source
        .getFrameAt(nextMs)
        .then((frame) => {
          if (frame) {
            screen.pushFrame(frame);
          }
          if (timelineRef.current !== timeline) {
            // A playhead reset superseded this fetch (seek, replay after
            // ended, source change), keep the new position. The pushFrame
            // above is deliberately not skipped: painting the already-fetched
            // frame is harmless and the reset's own fetch repaints right after.
            return;
          }
          if (waitingRef.current) {
            if (!frame) {
              // Still buffering: hold the playhead until the frame lands
              return;
            }
            // The picture is ready. Start audio at the position the
            // picture resumed from (once per hold), then keep holding
            // until the source's readahead is comfortably full and the
            // audio has made sound or reported it cannot, so playback
            // begins buffered and with both streams together.
            if (!audioStartedRef.current && readPlaying()) {
              audioStartedRef.current = true;
              audioRef.current?.playFrom(nextMs);
            }
            if (source.isBuffering?.() ?? false) {
              return;
            }
            if (readPlaying() && (audioRef.current?.isStarting() ?? false)) {
              return;
            }
            waitingRef.current = false;
            setBuffering(false);
            anchorRef.current = { wallMs: Date.now(), elapsedMs: nextMs };
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
            // Drift snap: audio can still drift from real gaps (a device
            // underrun after a delivery stall, device clock skew). Once
            // per displayed second is enough correction. The resync goes
            // through the gate (the next tick restarts audio at the
            // playhead and holds until it is audible), so a slow-starting
            // decoder is never respawned into a chase it cannot win.
            const audioPositionMs = audioRef.current?.getPositionMs() ?? null;
            if (
              audioPositionMs !== null &&
              playingRef.current &&
              Math.abs(audioPositionMs - nextMs) > DRIFT_RESYNC_THRESHOLD_MS
            ) {
              armGate();
            }
          }
        })
        .catch(noteSourceError)
        .finally(() => {
          inFlightRef.current = false;
        });
    },
    [armGate, info, noteSourceError, readPlaying, screen, source],
  );

  const pause = useCallback((): void => {
    if (!playingRef.current) {
      return;
    }
    playingRef.current = false;
    setPlaying(false);
    callbacksRef.current.onPause?.();
    // Re-check: an onPause handler may synchronously re-enter the clock
    // (e.g. call play()), and then audio must not be silenced afterward.
    if (!readPlaying()) {
      audioRef.current?.pause();
      // A held gate must issue a fresh audio start on resume, the paused
      // one was killed
      audioStartedRef.current = false;
    }
  }, [readPlaying]);

  const play = useCallback((): void => {
    if (endedRef.current) {
      // HTML5 semantics: play() after ended restarts from the beginning.
      // The timeline bump keeps the ended branch's still-in-flight final
      // frame paint from writing durationMs back over the reset playhead.
      // The replay is a backward jump that respawns the decoder, so the
      // gate holds until the first frame is back.
      endedRef.current = false;
      setEnded(false);
      timelineRef.current += 1;
      armGate();
      elapsedRef.current = 0;
      setElapsedMs(0);
    }
    if (playingRef.current) {
      return;
    }
    playingRef.current = true;
    setPlaying(true);
    callbacksRef.current.onPlay?.();
    // Re-check: an onPlay handler may synchronously re-enter the clock
    // (e.g. call pause()), and then audio must not start afterward.
    // Resume goes through the gate like every other start: hold until the
    // audio restarted at the playhead is audible, kicked immediately so a
    // local resume clears within a frame fetch instead of a full tick.
    if (readPlaying() && !waitingRef.current) {
      armGate();
      showFrameAt(elapsedRef.current);
    }
  }, [armGate, readPlaying, showFrameAt]);

  const togglePlay = useCallback((): void => {
    if (playingRef.current) {
      pause();
    } else {
      play();
    }
  }, [pause, play]);

  // Synchronous playhead move shared by seeks and loop wraps. Bumps the
  // timeline so an in-flight fetch from the old position cannot write its
  // timestamp over the new one, gates the clock on the frame at the target,
  // and mirrors HTML5 by reporting the jump immediately instead of when
  // that frame lands.
  const movePlayheadTo = useCallback(
    (targetMs: number): void => {
      if (info === null) {
        return;
      }
      timelineRef.current += 1;
      armGate();
      const previousSecond = Math.floor(elapsedRef.current / MS_PER_SECOND);
      const nextSecond = Math.floor(targetMs / MS_PER_SECOND);
      elapsedRef.current = targetMs;
      if (nextSecond !== previousSecond) {
        setElapsedMs(targetMs);
        callbacksRef.current.onTimeUpdate?.({
          currentTime: targetMs / MS_PER_SECOND,
          duration: info.durationMs / MS_PER_SECOND,
        });
      }
    },
    [armGate, info],
  );

  // A new source starts from zero (src/srcObject changes in managed mode).
  // Runs harmlessly on first mount, everything is already zero.
  useEffect(() => {
    timelineRef.current += 1;
    armGate();
    elapsedRef.current = 0;
    setElapsedMs(0);
    endedRef.current = false;
    setEnded(false);
  }, [armGate, source]);

  // Playback loop. Deps are stable while resources are stable, so this is
  // effectively mount-only per resource set and survives every rerender.
  useEffect(() => {
    if (screen === null || source === null || info === null) {
      return;
    }
    // A mid-playback effect re-run (the cleanup paused audio) restarts
    // audio through the gate like every other start. At mount and after
    // source changes the gate is already armed.
    if (playingRef.current && !waitingRef.current) {
      armGate();
    }
    showFrameAt(elapsedRef.current);
    const intervalMs = Math.round(MS_PER_SECOND / info.fps);
    const interval = setInterval(() => {
      if (!playingRef.current || !screen.isWritable() || inFlightRef.current) {
        return;
      }
      if (waitingRef.current && elapsedRef.current + intervalMs < info.durationMs) {
        // Buffering: retry the gated position instead of advancing. At the
        // end of the stream this falls through so a gated playhead parked
        // there still reaches the loop/ended handling below.
        showFrameAt(elapsedRef.current);
        return;
      }
      const nextMs = waitingRef.current
        ? elapsedRef.current + intervalMs
        : anchorRef.current.elapsedMs + (Date.now() - anchorRef.current.wallMs);
      if (nextMs < info.durationMs) {
        showFrameAt(nextMs);
        return;
      }
      if (loop) {
        // The wrap is a backward jump that respawns the decoder, so it
        // moves the playhead synchronously and gates like a seek. Audio
        // restarts when the wrapped frame paints.
        const wrappedMs = nextMs % info.durationMs;
        movePlayheadTo(wrappedMs);
        showFrameAt(wrappedMs);
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
      // Re-check: an onPause/onEnded handler may synchronously re-enter the
      // clock (e.g. call play()), and then audio must not be silenced.
      if (!readPlaying()) {
        audioRef.current?.pause();
      }
    }, intervalMs);
    return () => {
      clearInterval(interval);
      audioRef.current?.pause();
    };
  }, [armGate, info, loop, movePlayheadTo, readPlaying, screen, showFrameAt, source]);

  const seekToMs = useCallback(
    (targetMs: number): void => {
      if (source === null || info === null) {
        return;
      }
      const clampedMs = Math.min(Math.max(targetMs, 0), info.durationMs);
      endedRef.current = false;
      setEnded(false);
      // Audio deliberately does not restart here: the gate starts it at the
      // target once the sought frame paints, keeping sound and picture
      // aligned when the source needs time to reposition.
      movePlayheadTo(clampedMs);
      void source
        .seek(clampedMs)
        .then(() => {
          showFrameAt(clampedMs);
        })
        .catch(noteSourceError);
    },
    [info, movePlayheadTo, noteSourceError, showFrameAt, source],
  );

  const getElapsedMs = useCallback((): number => elapsedRef.current, []);

  const repaint = useCallback((): void => {
    showFrameAt(elapsedRef.current);
  }, [showFrameAt]);

  return {
    playing,
    elapsedMs,
    ended,
    buffering,
    play,
    pause,
    togglePlay,
    seekToMs,
    getElapsedMs,
    repaint,
    noteSourceError,
  };
};
