#!/usr/bin/env node
/**
 * Executable CLI entry (built as dist/cli.js, the package bin). Parses argv,
 * guards on terminal capability, then hands either a procedural or an
 * ffmpeg-decoded FrameSource and a kitty-motion Screen to the Ink Video component.
 * In fallback mode the Screen goes to runFallbackPlayer instead and Ink
 * never renders. Importing this module runs the CLI, so tests import
 * parseCliArgs from ./parseCliArgs.ts directly.
 */
import { render } from 'ink';
import { createScreen, detectCellPixelSize } from 'kitty-motion';
import type { RenderMode } from 'kitty-motion';

import type { AudioPlayer } from '../audioPlayer/index.ts';
import { createFallbackScreen, resolveFallbackRenderMode, runFallbackPlayer } from '../fallbackPlayer/index.ts';
import { createFfmpegAudioPlayer } from '../ffmpegAudioPlayer/index.ts';
import { isFfmpegSourceError } from '../ffmpegSource/index.ts';
import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';
import { isMediaProbeError, probeMediaFile } from '../mediaProbe/index.ts';
import { Video } from '../Video/index.tsx';
import { computePanelRegion } from '../playerLayout/index.ts';
import { createProceduralSource } from '../proceduralSource/index.ts';
import { confirmFallback } from './confirmFallback.ts';
import {
  EXIT_OK,
  EXIT_USAGE,
  FALLBACK_KITTY_NOTE,
  FALLBACK_PROMPT,
  FALLBACK_PROMPT_KITTY,
  FALLBACK_REASON_MESSAGES,
  FALLBACK_WARNING_HEADER,
  HELP_TEXT,
  UNSUPPORTED_TERMINAL_MESSAGE,
  VERSION,
} from './consts.ts';
import { detectFallbackReasons } from './detectFallbackReasons.ts';
import { startLoadingIndicator } from './loadingIndicator.ts';
import { openMediaSource } from './openMediaSource.ts';
import { parseCliArgs } from './parseCliArgs.ts';

export { parseCliArgs } from './parseCliArgs.ts';
export { detectFallbackReasons } from './detectFallbackReasons.ts';
export { confirmFallback } from './confirmFallback.ts';
export { startLoadingIndicator } from './loadingIndicator.ts';
export { openMediaSource } from './openMediaSource.ts';
export * from './consts.ts';
export * from './types.ts';

const args = parseCliArgs(process.argv.slice(2));

if (args.action === 'help') {
  process.stdout.write(`${HELP_TEXT}\n`);
  process.exit(EXIT_OK);
}

if (args.action === 'version') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(EXIT_OK);
}

if (args.action === 'usage-error') {
  process.stderr.write(`kitty-media-player: ${args.message}\n\n${HELP_TEXT}\n`);
  process.exit(EXIT_USAGE);
}

// A prompt is impossible without a TTY and fallback output to a pipe is
// garbage, so --fallback does not override this. Exit 0 keeps CI green.
if (!process.stdout.isTTY) {
  process.stderr.write(`${UNSUPPORTED_TERMINAL_MESSAGE}\n`);
  process.exit(EXIT_OK);
}

// --render-mode kitty alone forces the full Ink player past detection.
// --fallback or a cell --render-mode forces the fallback player, and
// --fallback --render-mode kitty forces the fallback player with the kitty
// renderer (full quality, no on-screen UI, for terminals like iTerm2 that
// have graphics but no placeholders). Plain --fallback probes for the best
// available mode. This all happens before any Screen or Ink render exists,
// so the prompt and the graphics probe can read stdin freely.
const forceKitty = args.renderMode === 'kitty' && !args.fallback;
let fallback = args.fallback || (args.renderMode !== undefined && !forceKitty);
let fallbackMode: RenderMode | undefined;
if (fallback) {
  fallbackMode = await resolveFallbackRenderMode(args.renderMode);
} else if (!forceKitty) {
  const reasons = detectFallbackReasons();
  if (reasons.length > 0) {
    // Resolve before prompting because the wording depends on whether
    // kitty graphics work here without placeholders.
    fallbackMode = await resolveFallbackRenderMode();
    const reasonLines = reasons.map((reason) => `  - ${FALLBACK_REASON_MESSAGES[reason]}`);
    process.stderr.write(`${FALLBACK_WARNING_HEADER}\n${reasonLines.join('\n')}\n`);
    if (fallbackMode === 'kitty') {
      process.stderr.write(`${FALLBACK_KITTY_NOTE}\n`);
    }
    fallback = await confirmFallback({
      input: process.stdin,
      output: process.stderr,
      prompt: fallbackMode === 'kitty' ? FALLBACK_PROMPT_KITTY : FALLBACK_PROMPT,
    });
    if (!fallback) {
      process.exit(EXIT_OK);
    }
  }
}

// Only file playback has audio. The procedural demo is silent, and a file
// whose audio cannot play (no stream, no device) resolves hasAudio false
// and is closed again, so the players below see null and skip every call.
// One classification probe runs per file and feeds both pipelines: the
// source construction branches on it, and the audio player reads its
// has-audio answer from it, so startup runs one ffprobe and the audio
// device open hides behind the source open.
const openingProbe = args.file === undefined ? null : probeMediaFile(args.file);
const audioPlayer =
  args.file === undefined || openingProbe === null
    ? null
    : createFfmpegAudioPlayer({
        filePath: args.file,
        probeAudio: async () => {
          const probe = await openingProbe;
          return probe.kind === 'audio' ? true : probe.hasAudio;
        },
      });

// Resolves the opened player or null, never rejects: AudioPlayer.open()
// and close() resolve on every failure by contract, so no try/catch is
// needed around them here
const openAudio = async (): Promise<AudioPlayer | null> => {
  if (audioPlayer === null) {
    return null;
  }
  const { hasAudio } = await audioPlayer.open();
  if (hasAudio) {
    return audioPlayer;
  }
  await audioPlayer.close();
  return null;
};

// A slow open says so instead of sitting silent: remote URLs probe (and
// sometimes measure their duration) over the network, which can take
// seconds. The indicator is delayed internally so fast local opens never
// flash it, and stopped explicitly on the error path because process.exit
// skips finally blocks.
const loadingIndicator = args.file === undefined ? null : startLoadingIndicator(args.file);

let source: FrameSource;
let info: FrameSourceInfo;
let audio: AudioPlayer | null = null;
try {
  if (args.file === undefined || openingProbe === null) {
    source = createProceduralSource();
    info = await source.open();
  } else {
    const file = args.file;
    const openingSource = openingProbe.then((probe) => openMediaSource({ filePath: file, probe }));
    const [opened, openedAudio] = await Promise.all([openingSource, openAudio()]);
    ({ source, info } = opened);
    audio = openedAudio;
  }
} catch (error) {
  loadingIndicator?.stop();
  await audioPlayer?.close().catch(() => undefined);
  const message =
    isMediaProbeError(error) || isFfmpegSourceError(error) ? error.message : String(error);
  process.stderr.write(`kitty-media-player: ${message}\n`);
  process.exit(EXIT_USAGE);
}
loadingIndicator?.stop();

// Fallback mode never touches Ink. The renderer owns the whole screen
// (kitty at full quality or a cell renderer) and produces no placeholder
// rows to lay out. The playback loop resolves when the user quits, with
// the screen disposed and source closed.
if (fallbackMode !== undefined) {
  // The kitty tier measures the real cell pixel size so the frame keeps its
  // aspect on fonts other than the assumed 9x18. stdin is still free here,
  // and this runs after the graphics probe, never concurrently with another
  // detector. Cell tiers stay probe-free.
  if (fallbackMode === 'kitty') {
    await detectCellPixelSize();
  }
  const fallbackScreen = createFallbackScreen(info, fallbackMode);
  await runFallbackPlayer({
    screen: fallbackScreen,
    source,
    info,
    input: process.stdin,
    audio,
    muted: args.muted,
  });
  process.exit(EXIT_OK);
}

const region = computePanelRegion({
  termCols: process.stdout.columns,
  termRows: process.stdout.rows,
  sourceWidth: info.width,
  sourceHeight: info.height,
});

// Create the Screen before rendering Ink: createScreen runs terminal probes
// that read stdin, and that must finish before Ink's useInput takes over stdin.
let screen: Awaited<ReturnType<typeof createScreen>>;
try {
  screen = await createScreen({
    output: process.stdout,
    sourceWidth: info.width,
    sourceHeight: info.height,
    colorSpace: info.colorSpace,
    renderMode: forceKitty ? 'kitty' : undefined,
    placement: 'unicode',
    embedded: true,
    region,
    autoResize: false,
    autoDispose: false,
  });
} catch (error) {
  // A failed probe handshake must not strand the decoder processes
  await source.close().catch(() => undefined);
  await audio?.close().catch(() => undefined);
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`kitty-media-player: ${message}\n`);
  process.exit(EXIT_USAGE);
}

// exitOnCtrlC: false so Video's own input handler can dispose the Screen
// and close the source before Ink tears the render down.
render(
  <Video
    screen={screen}
    source={source}
    info={info}
    audio={audio ?? undefined}
    muted={args.muted}
    autoPlay
    loop
    controls
    keyboard
    title
    help
  />,
  { exitOnCtrlC: false },
);
