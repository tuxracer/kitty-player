# kitty-video-player technical reference

How kitty-video-player works internally. For installation, controls, and CLI flags,
see the [README](../README.md).

## Overview

kitty-video-player has two rendering paths. The full player is an
[Ink](https://github.com/vadimdemedes/ink) app whose video pixels are drawn by
[kitty-motion](https://github.com/tuxracer/kitty-motion) through Kitty graphics
Unicode placeholders. The placeholder cells are ordinary text that Ink lays
out, so the picture and the React-driven UI share the terminal without
stepping on each other. The fallback player skips Ink entirely and drives a
kitty-motion Screen directly, for terminals that cannot host the full player.

## Startup sequence

The CLI entry (`src/cli/index.tsx`) runs the player at module top level.
Argument parsing lives in `parseCliArgs`, a pure function in its own file so
tests can import it without executing the entry.

1. Parse argv. Unsupported flags and extra positionals exit with an error.
2. Guard on terminal capability. If stdout is not a TTY, print a notice and
   exit 0 (CI-friendly, nothing is drawn).
3. Resolve the render path (see below).
4. Open the `FrameSource`. A file argument opens `ffmpegSource`, no argument
   opens the built-in `proceduralSource`.
5. Run the full player or the fallback player.

### Render path resolution

Forced modes resolve immediately, with no probe and no prompt:

- `--render-mode kitty` alone forces the full Ink player past detection.
- `--fallback` alone, a cell `--render-mode` (half-block, cell-background,
  emoji, ascii), or `--fallback --render-mode kitty` all force the fallback
  player. The last combination is a forced kitty-without-controls tier for
  terminals like iTerm2 that have graphics but no placeholders. It is also the
  escape hatch for tmux with allow-passthrough configured.

With no flags, `detectFallbackReasons` checks for missing placeholder support
and tmux/screen sessions. If it reports a reason, the CLI resolves the
fallback tier first via `resolveFallbackRenderMode`, then warns and prompts
with wording that matches the resolved tier. Declining exits 0.

`resolveFallbackRenderMode` picks the tier in this order:

1. A forced mode wins untouched.
2. A multiplexed session (tmux or GNU screen) skips the graphics probe and
   takes the auto cell mode. The multiplexer swallows the graphics escapes
   even when the environment looks like kitty, so the kitty tier is never
   auto-selected there.
3. Otherwise the kitty graphics probe decides. A pass selects kitty graphics
   without controls, a fail falls through to `detectCellRenderMode`
   (cell-background on Terminal.app, half-block elsewhere).

## The full player

### Screen creation must precede Ink render

The CLI computes the panel region with `computePanelRegion` and awaits
kitty-motion's `createScreen` BEFORE calling Ink's `render()`. This ordering
is load-bearing. The kitty-motion capability probes read responses from
stdin, and Ink's `useInput` takes stdin over once rendering starts. Creating
the Screen after rendering hangs or corrupts the probe handshake.

The CLI then renders
`<Video screen source info autoPlay loop controls keyboard title help />` with
`exitOnCtrlC: false`, so Video's own input handler can dispose the Screen and
close the source before Ink tears down.

### Placeholder rendering

`Screen.getPlaceholderRows()` returns one string per grid row, and Video
renders each as an ordinary Ink `<Text>`. The terminal fills those cells with
the video, so the picture participates in Ink layout like any other text.

### Playback clock

`Video` owns the playback clock, in the `usePlaybackClock` hook:

- A `setInterval` at the source frame rate lives outside React state. Refs
  mirror `playing` and elapsed time as the source of truth for the interval
  callback.
- An in-flight guard keeps async `getFrameAt` calls from piling up behind a
  slow source.
- Frames go straight to `screen.pushFrame()`, bypassing React entirely, so
  pixels update at the source frame rate without any Ink redraw.
- React state (and therefore an Ink redraw) updates only when the displayed
  whole second changes. Ink redraws roughly once per second, for the time
  readout and progress bar.

### Resize handling

On terminal resize Video debounces the stdout `resize` event
(`RESIZE_DEBOUNCE_MS`, 150 ms), calls `screen.setRegion()` with a freshly
computed panel region, re-reads `screen.getPlaceholderRows()`, and repaints
the current frame. The re-read matters because the placeholder grid size can
change with the region, so cached rows go stale.

## The fallback player

`src/fallbackPlayer/` handles terminals that cannot run the full Ink player.
`createFallbackScreen` builds a probe-free Screen at the resolved render mode
(full-screen, autoResize), and `runFallbackPlayer` is a React-free port of
the playback clock with raw-stdin keys (space, arrows, q/Ctrl-C) and no Ink
UI. It never renders Ink.

## The FrameSource contract

`src/frameSource/` holds the `FrameSource`/`FrameSourceInfo` contract as an
interface-only module (no implementation, no consts). It is a pull model. The
player's clock requests frames by timestamp:

- `open()` returns the stream info (pixel dimensions, color space, duration,
  frame rate).
- `getFrameAt(timeMs)` resolves the frame at or nearest after that timestamp.
  `null` means no frame is ready and the player keeps showing the last one.
  Returned buffers may be reused by the source, so they are valid only until
  the next call.
- `seek(timeMs)` repositions the source so nearby reads are cheap (a no-op
  for random-access sources).
- `close()` releases decoder resources and is idempotent.

## Built-in sources

### proceduralSource

The demo source, a hue-cycling ball on a Lissajous path over a 20 second
loop, rendered as a pure function of time into a reused framebuffer. It plays
when the CLI is run with no file argument.

### ffmpegSource

Decodes video files with bundled ffmpeg-static and ffprobe-static, so no
system install is needed:

- ffprobe runs a metadata probe up front (dimensions, duration, frame rate,
  display-matrix rotation).
- One streaming ffmpeg process decodes rawvideo rgb24 into a readahead queue,
  capped at 60 frames (about one second of video), with stream pause/resume
  backpressure.
- A seek or backward time jump respawns ffmpeg with input-side `-ss`.
- Frames are scaled to fit 960x540 at decode time. kitty-motion scales the
  framebuffer to the panel region anyway, so decoding beyond that cap is
  wasted memory and CPU (a 4K rgb24 frame is about 24 MB, a capped one about
  1.5 MB).

## Layout

`src/playerLayout/` sizes the video panel:

- `computePanelRegion` sizes the panel's cell grid from the terminal size via
  kitty-motion's `fitToTerminal`.
- `computeEmbeddedRegion` letterboxes a source frame into a fixed cell box for
  embedded mode. It deliberately does not use `fitToTerminal`, whose
  minimum-display floor distorts small boxes.

## Module map

- `src/cli/` - executable bin entry (`index.tsx` runs the player on import)
  plus `parseCliArgs.ts`, `detectFallbackReasons.ts`, `confirmFallback.ts`,
  the exit codes, help text, and `VERSION`
- `src/Video/` - the Ink component `Video`, the playback clock in
  `usePlaybackClock.ts`,
  self-managed resource lifecycle in `useManagedResources.ts`, probe-free
  Screen construction in `managedScreen.ts`, and the two-mode props union
  (external resources vs. self-managed)
- `src/frameSource/` - the `FrameSource`/`FrameSourceInfo` contract
- `src/fallbackPlayer/` - `resolveFallbackRenderMode`, `createFallbackScreen`,
  and `runFallbackPlayer`
- `src/proceduralSource/` - the built-in demo source
- `src/ffmpegSource/` - the file decoder
- `src/playerLayout/` - `computePanelRegion` and `computeEmbeddedRegion`
- `src/formatTime/` - millisecond timestamps as `m:ss`, switching to
  `h:mm:ss` at one hour
- `src/index.ts` - library entry with explicit (not star) re-exports, because
  several modules define their own `MS_PER_SECOND` and star exports would
  silently drop the ambiguous name

## Build layout

The build (tsup) has two entries that must stay separate bundles:

- `cli` (`dist/cli.js`) is the executable bin. It runs the player at module
  top level, so importing it starts playback.
- `index` (`dist/index.js`) is the library entry, for hosts embedding the
  `Video` component in their own Ink app.
