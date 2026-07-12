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

import { createFfmpegSource, isFfmpegSourceError } from '../ffmpegSource/index.ts';
import { createFallbackScreen, resolveFallbackRenderMode, runFallbackPlayer } from '../fallbackPlayer/index.ts';
import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';
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
import { parseCliArgs } from './parseCliArgs.ts';

export { parseCliArgs } from './parseCliArgs.ts';
export { detectFallbackReasons } from './detectFallbackReasons.ts';
export { confirmFallback } from './confirmFallback.ts';
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
  process.stderr.write(`kitty-video-player: ${args.message}\n\n${HELP_TEXT}\n`);
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

const source: FrameSource =
  args.file === undefined ? createProceduralSource() : createFfmpegSource({ filePath: args.file });

let info: FrameSourceInfo;
try {
  info = await source.open();
} catch (error) {
  const message = isFfmpegSourceError(error) ? error.message : String(error);
  process.stderr.write(`kitty-video-player: ${message}\n`);
  process.exit(EXIT_USAGE);
}

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
const screen = await createScreen({
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

// exitOnCtrlC: false so Video's own input handler can dispose the Screen
// and close the source before Ink tears the render down.
render(
  <Video screen={screen} source={source} info={info} autoPlay loop controls keyboard title help />,
  { exitOnCtrlC: false },
);
