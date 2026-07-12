import { ProgressBar } from '@inkjs/ui';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { ReactElement } from 'react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { formatTime } from '../formatTime/index.ts';
import { computeEmbeddedRegion, computePanelRegion } from '../playerLayout/index.ts';
import {
  HELP_TEXT,
  LOADING_DELAY_MS,
  LOADING_TEXT,
  MS_PER_SECOND,
  PAUSE_GLYPH,
  PERCENT_MAX,
  PLAY_GLYPH,
  PLAYER_TITLE,
  PROGRESS_BAR_WIDTH,
  RESIZE_DEBOUNCE_MS,
  SEEK_STEP_MS,
} from './consts.ts';
import type { VideoProps, VideoRef } from './types.ts';
import { useManagedResources } from './useManagedResources.ts';
import { usePlaybackClock } from './usePlaybackClock.ts';

export * from './consts.ts';
export * from './types.ts';
export { canDisplayVideo, createManagedScreen } from './managedScreen.ts';
export { useManagedResources } from './useManagedResources.ts';
export { usePlaybackClock } from './usePlaybackClock.ts';

/**
 * Ink video component with an HTML5-video-shaped API. kitty-motion owns the
 * video pixels (pushed into placeholder cells that Ink lays out as ordinary
 * text). React state only mirrors what the chrome displays, so Ink redraws
 * about once per second while frames update at the source frame rate.
 *
 * Two modes, discriminated on the screen prop. Without it (self-managed) the
 * component creates its own Screen and source from src or srcObject, sized
 * by the width and height props in cells. With it (external resources) the
 * host owns the Screen and source lifecycle, as the CLI does.
 */
export const Video = forwardRef<VideoRef, VideoProps>((props, ref): ReactElement => {
  const {
    autoPlay = false,
    loop = false,
    muted: initialMuted = false,
    controls = false,
    keyboard = false,
    title = false,
    help = false,
    children,
    onTimeUpdate,
    onLoadedMetadata,
    onPlay,
    onPause,
    onEnded,
    onError,
  } = props;
  const external = props.screen !== undefined;

  const { exit } = useApp();
  const { stdout } = useStdout();

  const managed = useManagedResources({
    enabled: !external,
    src: props.screen === undefined ? props.src : undefined,
    srcObject: props.screen === undefined ? props.srcObject : undefined,
    width: props.screen === undefined ? props.width : 0,
    height: props.screen === undefined ? props.height : 0,
    onLoadedMetadata,
    onError,
  });

  const screen = props.screen === undefined ? managed.screen : props.screen;
  const source = props.screen === undefined ? managed.source : props.source;
  const info = props.screen === undefined ? managed.info : props.info;
  // Managed audio arrives in Task 9, so managed mode passes null for now.
  const audio = props.screen === undefined ? null : (props.audio ?? null);

  const [placeholderRows, setPlaceholderRows] = useState<string[]>(() =>
    props.screen === undefined ? [] : props.screen.getPlaceholderRows(),
  );

  const [muted, setMuted] = useState(initialMuted);

  // The muted state is the source of truth, the audio player follows it.
  // Also reapplies after the audio resource itself changes (managed mode).
  useEffect(() => {
    audio?.setMuted(muted);
  }, [audio, muted]);

  const clock = usePlaybackClock({
    screen,
    source,
    info,
    audio,
    autoPlay,
    loop,
    stderrNote: external,
    onTimeUpdate,
    onPlay,
    onPause,
    onEnded,
    onError,
  });
  const { getElapsedMs, noteSourceError, repaint, seekToMs, togglePlay } = clock;

  useImperativeHandle(
    ref,
    () => ({
      play: (): Promise<void> => {
        clock.play();
        return Promise.resolve();
      },
      pause: (): void => {
        clock.pause();
      },
      get currentTime(): number {
        return clock.getElapsedMs() / MS_PER_SECOND;
      },
      set currentTime(seconds: number) {
        clock.seekToMs(seconds * MS_PER_SECOND);
      },
      get paused(): boolean {
        return !clock.playing;
      },
      get ended(): boolean {
        return clock.ended;
      },
      get muted(): boolean {
        return muted;
      },
      set muted(value: boolean) {
        setMuted(value);
      },
      get duration(): number {
        return info === null ? Number.NaN : info.durationMs / MS_PER_SECOND;
      },
      get videoWidth(): number {
        return info?.width ?? 0;
      },
      get videoHeight(): number {
        return info?.height ?? 0;
      },
    }),
    // clock is a new object every render (usePlaybackClock does not memoize
    // its return), so this dependency keeps the handle fresh. Memoizing the
    // hook's return instead would stale paused/ended here.
    [clock, info, muted],
  );

  // HTML5 fires loadedmetadata once dimensions and duration are known. In
  // external mode they are known at mount (managed mode fires from its hook).
  const onLoadedMetadataRef = useRef(onLoadedMetadata);
  onLoadedMetadataRef.current = onLoadedMetadata;
  useEffect(() => {
    if (external && info !== null) {
      onLoadedMetadataRef.current?.({
        videoWidth: info.width,
        videoHeight: info.height,
        duration: info.durationMs / MS_PER_SECOND,
      });
    }
  }, [external, info]);

  // Placeholder rows track the active screen (arrives async in managed mode)
  useEffect(() => {
    setPlaceholderRows(screen === null ? [] : screen.getPlaceholderRows());
  }, [screen]);

  useInput(
    (input, key) => {
      if (input === 'q' || (key.ctrl && input === 'c')) {
        screen?.dispose();
        void source?.close().catch(noteSourceError);
        void audio?.close().catch(noteSourceError);
        exit();
        return;
      }
      if (input === ' ') {
        togglePlay();
        return;
      }
      if (input === 'm') {
        setMuted((value) => !value);
        return;
      }
      if (key.leftArrow) {
        seekToMs(getElapsedMs() - SEEK_STEP_MS);
        return;
      }
      if (key.rightArrow) {
        seekToMs(getElapsedMs() + SEEK_STEP_MS);
      }
    },
    { isActive: keyboard && screen !== null },
  );

  // External mode: terminal resizes relayout the panel, debounced so a
  // drag-resize settles before the region changes. Placeholder rows must be
  // re-read after setRegion because the grid size can change.
  useEffect(() => {
    if (!external || screen === null || info === null) {
      return;
    }
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
  }, [external, info, repaint, screen, stdout]);

  // Managed mode: width/height prop changes recompute the letterbox region.
  // Same gotcha as resize, rows must be re-read after setRegion.
  const managedWidth = props.screen === undefined ? props.width : 0;
  const managedHeight = props.screen === undefined ? props.height : 0;
  useEffect(() => {
    if (external || screen === null || info === null) {
      return;
    }
    const region = computeEmbeddedRegion({
      cols: managedWidth,
      rows: managedHeight,
      sourceWidth: info.width,
      sourceHeight: info.height,
    });
    screen.setRegion(region);
    setPlaceholderRows(screen.getPlaceholderRows());
    repaint();
  }, [external, info, managedHeight, managedWidth, repaint, screen]);

  // Loading indicator, delayed so fast opens never flash it
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (external || managed.status !== 'loading') {
      setShowLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowLoading(true);
    }, LOADING_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [external, managed.status]);

  if (props.screen === undefined) {
    if (managed.status === 'unsupported' || managed.status === 'error') {
      return (
        <Box
          width={props.width}
          height={props.height}
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
        >
          {children}
        </Box>
      );
    }
    if (managed.status === 'loading') {
      return (
        <Box
          width={props.width}
          height={props.height}
          justifyContent="center"
          alignItems="center"
        >
          {showLoading ? <Text dimColor>{LOADING_TEXT}</Text> : null}
        </Box>
      );
    }
  }

  const durationMs = info?.durationMs ?? 0;
  const progressPercent =
    durationMs > 0
      ? Math.min(Math.max(Math.round((clock.elapsedMs / durationMs) * PERCENT_MAX), 0), PERCENT_MAX)
      : 0;

  const rows = (
    <Box flexDirection="column">
      {placeholderRows.map((row, i) => (
        <Text key={i}>{row}</Text>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {title ? (
        <Text bold color="cyan">
          {PLAYER_TITLE}
        </Text>
      ) : null}
      {props.screen === undefined ? (
        <Box
          width={props.width}
          height={props.height}
          flexDirection="column"
          justifyContent="center"
          alignItems="center"
        >
          {rows}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={title ? 1 : 0}>
          {rows}
        </Box>
      )}
      {controls ? (
        <Box marginTop={1}>
          <Text>{clock.playing ? PLAY_GLYPH : PAUSE_GLYPH} </Text>
          <Box width={PROGRESS_BAR_WIDTH}>
            <ProgressBar value={progressPercent} />
          </Box>
          <Text>
            {' '}
            {formatTime(clock.elapsedMs)} / {formatTime(durationMs)}
          </Text>
        </Box>
      ) : null}
      {help ? <Text dimColor>{HELP_TEXT}</Text> : null}
    </Box>
  );
});

Video.displayName = 'Video';
