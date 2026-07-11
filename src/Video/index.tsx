import { ProgressBar } from '@inkjs/ui';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { formatTime } from '../formatTime/index.ts';
import { computePanelRegion } from '../playerLayout/index.ts';
import {
  HELP_TEXT,
  MS_PER_SECOND,
  PAUSE_GLYPH,
  PERCENT_MAX,
  PLAY_GLYPH,
  PLAYER_TITLE,
  PROGRESS_BAR_WIDTH,
  RESIZE_DEBOUNCE_MS,
  SEEK_STEP_MS,
} from './consts.ts';
import type { PlayerProps } from './types.ts';

export * from './consts.ts';
export * from './types.ts';

/**
 * Ink video component. kitty-motion owns the video pixels (pushed into
 * placeholder cells that Ink lays out as ordinary text). React state only
 * mirrors what the chrome displays, so Ink redraws about once per second
 * while frames update at the source frame rate.
 */
export const Video = ({ screen, source, info }: PlayerProps): ReactElement => {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [playing, setPlaying] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [placeholderRows, setPlaceholderRows] = useState<string[]>(() =>
    screen.getPlaceholderRows(),
  );

  // Refs are the source of truth for the interval callback (state is only the
  // rendered mirror), and inFlightRef keeps async getFrameAt calls from
  // piling up behind a slow source.
  const playingRef = useRef(true);
  const elapsedRef = useRef(0);
  const inFlightRef = useRef(false);
  const sourceErrorNotedRef = useRef(false);

  const noteSourceError = useCallback((): void => {
    if (!sourceErrorNotedRef.current) {
      sourceErrorNotedRef.current = true;
      process.stderr.write('kitty-player: frame source error, playback continues\n');
    }
  }, []);

  // Fetch and display the frame at nextMs. Elapsed time always lands in the
  // ref, but React state (and so an Ink redraw) only updates when the
  // displayed whole second changes.
  const showFrameAt = useCallback(
    (nextMs: number): void => {
      if (inFlightRef.current) {
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
          }
        })
        .catch(noteSourceError)
        .finally(() => {
          inFlightRef.current = false;
        });
    },
    [noteSourceError, screen, source],
  );

  // Playback loop. Deps are stable for the component's lifetime (screen,
  // source, and info never change identity in practice), so this is
  // effectively mount-only and the interval survives every rerender.
  useEffect(() => {
    showFrameAt(elapsedRef.current);
    const intervalMs = Math.round(MS_PER_SECOND / info.fps);
    const interval = setInterval(() => {
      if (playingRef.current && screen.isWritable() && !inFlightRef.current) {
        showFrameAt((elapsedRef.current + intervalMs) % info.durationMs);
      }
    }, intervalMs);
    return () => {
      clearInterval(interval);
    };
  }, [info.durationMs, info.fps, screen, showFrameAt]);

  const seekTo = useCallback(
    (targetMs: number): void => {
      const clampedMs = Math.min(Math.max(targetMs, 0), info.durationMs);
      void source
        .seek(clampedMs)
        .then(() => {
          showFrameAt(clampedMs);
        })
        .catch(noteSourceError);
    },
    [info.durationMs, noteSourceError, showFrameAt, source],
  );

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      screen.dispose();
      void source.close().catch(noteSourceError);
      exit();
      return;
    }
    if (input === ' ') {
      const next = !playingRef.current;
      playingRef.current = next;
      setPlaying(next);
      return;
    }
    if (key.leftArrow) {
      seekTo(elapsedRef.current - SEEK_STEP_MS);
      return;
    }
    if (key.rightArrow) {
      seekTo(elapsedRef.current + SEEK_STEP_MS);
    }
  });

  // Terminal resizes relayout the panel, debounced so a drag-resize settles
  // before the region changes. Placeholder rows must be re-read after
  // setRegion because the grid size can change.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        const region = computePanelRegion({
          termCols: stdout.columns,
          termRows: stdout.rows,
          sourceWidth: info.width,
          sourceHeight: info.height,
        });
        screen.setRegion(region);
        setPlaceholderRows(screen.getPlaceholderRows());
        showFrameAt(elapsedRef.current);
      }, RESIZE_DEBOUNCE_MS);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [info.height, info.width, screen, showFrameAt, stdout]);

  const progressPercent =
    info.durationMs > 0
      ? Math.min(
          Math.max(Math.round((elapsedMs / info.durationMs) * PERCENT_MAX), 0),
          PERCENT_MAX,
        )
      : 0;

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {PLAYER_TITLE}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {placeholderRows.map((row, i) => (
          <Text key={i}>{row}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text>{playing ? PLAY_GLYPH : PAUSE_GLYPH} </Text>
        <Box width={PROGRESS_BAR_WIDTH}>
          <ProgressBar value={progressPercent} />
        </Box>
        <Text>
          {' '}
          {formatTime(elapsedMs)} / {formatTime(info.durationMs)}
        </Text>
      </Box>
      <Text dimColor>{HELP_TEXT}</Text>
    </Box>
  );
};

/** Backwards-compatible alias, the component was originally exported as Player */
export const Player = Video;
