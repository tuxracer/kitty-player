import { ProgressBar } from '@inkjs/ui';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

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
import { usePlaybackClock } from './usePlaybackClock.ts';

export * from './consts.ts';
export * from './types.ts';
export { usePlaybackClock } from './usePlaybackClock.ts';

/**
 * Ink video component. kitty-motion owns the video pixels (pushed into
 * placeholder cells that Ink lays out as ordinary text). React state only
 * mirrors what the chrome displays, so Ink redraws about once per second
 * while frames update at the source frame rate.
 */
export const Video = ({
  screen,
  source,
  info,
  autoPlay = false,
  loop = false,
  onTimeUpdate,
  onLoadedMetadata,
  onPlay,
  onPause,
  onEnded,
  onError,
}: PlayerProps): ReactElement => {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [placeholderRows, setPlaceholderRows] = useState<string[]>(() =>
    screen.getPlaceholderRows(),
  );

  const clock = usePlaybackClock({
    screen,
    source,
    info,
    autoPlay,
    loop,
    stderrNote: true,
    onTimeUpdate,
    onPlay,
    onPause,
    onEnded,
    onError,
  });
  const { getElapsedMs, noteSourceError, repaint, seekToMs, togglePlay } = clock;

  // HTML5 fires loadedmetadata once dimensions and duration are known. In
  // external mode they are known at mount.
  const onLoadedMetadataRef = useRef(onLoadedMetadata);
  onLoadedMetadataRef.current = onLoadedMetadata;
  useEffect(() => {
    onLoadedMetadataRef.current?.({
      videoWidth: info.width,
      videoHeight: info.height,
      duration: info.durationMs / MS_PER_SECOND,
    });
  }, [info]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      screen.dispose();
      void source.close().catch(noteSourceError);
      exit();
      return;
    }
    if (input === ' ') {
      togglePlay();
      return;
    }
    if (key.leftArrow) {
      seekToMs(getElapsedMs() - SEEK_STEP_MS);
      return;
    }
    if (key.rightArrow) {
      seekToMs(getElapsedMs() + SEEK_STEP_MS);
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
        repaint();
      }, RESIZE_DEBOUNCE_MS);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [info.height, info.width, repaint, screen, stdout]);

  const progressPercent =
    info.durationMs > 0
      ? Math.min(
          Math.max(Math.round((clock.elapsedMs / info.durationMs) * PERCENT_MAX), 0),
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
        <Text>{clock.playing ? PLAY_GLYPH : PAUSE_GLYPH} </Text>
        <Box width={PROGRESS_BAR_WIDTH}>
          <ProgressBar value={progressPercent} />
        </Box>
        <Text>
          {' '}
          {formatTime(clock.elapsedMs)} / {formatTime(info.durationMs)}
        </Text>
      </Box>
      <Text dimColor>{HELP_TEXT}</Text>
    </Box>
  );
};

/** Backwards-compatible alias, the component was originally exported as Player */
export const Player = Video;
