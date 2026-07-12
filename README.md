# kitty-player

A terminal video player. The UI (title, progress bar, controls) is an [Ink](https://github.com/vadimdemedes/ink) app, and the video pixels are rendered by [kitty-motion](https://github.com/tuxracer/kitty-motion) through Kitty graphics Unicode placeholders. The placeholder cells are ordinary text that Ink lays out, so the picture and the React-driven UI share the terminal without stepping on each other.

## Requirements

- Node.js >= 24
- An interactive Kitty or [Ghostty](https://ghostty.org/) terminal outside tmux or GNU screen. Other
  interactive terminals get an offer to play in a reduced fallback mode
  without on-screen controls (see the `--fallback` and `--render-mode` flags).
  When stdout is not a TTY it prints a notice and exits without drawing
- ffmpeg is bundled (via ffmpeg-static and ffprobe-static), no system install needed

## Install and run

```sh
npx kitty-player
npx kitty-player movie.mp4
```

Or install globally:

```sh
npm install -g kitty-player
kitty-player
```

For development from a checkout:

```sh
pnpm install
pnpm dev
```

## Current status

kitty-player plays video files (`kitty-player movie.mp4`) through a bundled ffmpeg,
decoded as a stream at a capped resolution with seek and pause. Audio is not
played yet. Running with no arguments plays the built-in procedural demo clip,
a hue-cycling ball moving on a Lissajous path over a 20 second loop.

## Controls

| Key              | Action           |
| ---------------- | ---------------- |
| space            | play or pause    |
| left/right arrow | seek 5 seconds   |
| q or Ctrl-C      | quit             |

## CLI flags

| Flag                   | Action                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<file>`               | play this video file (optional, plays the built-in demo when omitted)                                                                                                                                                            |
| `-h`, `--help`         | print help and exit                                                                                                                                                                                                              |
| `-v`, `--version`      | print the version and exit                                                                                                                                                                                                       |
| `--fallback`           | play without the Ink UI using the best available renderer (kitty graphics without controls when supported, otherwise a cell renderer)                                                                                            |
| `--render-mode <mode>` | force a render mode: kitty, half-block, cell-background, emoji, or ascii (kitty alone forces the full player, cell modes force the fallback player, and `--fallback --render-mode kitty` forces kitty graphics without controls) |

## How it works

- The kitty-motion `Screen` is created before Ink renders. Its terminal probes read responses from stdin, and that handshake must finish before Ink's `useInput` takes stdin over
- `Screen.getPlaceholderRows()` returns one string per grid row, and the player renders each as an ordinary Ink `<Text>`. The terminal fills those cells with the video
- Each frame goes straight to `screen.pushFrame()`, so pixels update at the source frame rate without any Ink redraw
- Ink itself redraws only when the displayed whole second changes (the time readout and progress bar), roughly once per second
- On terminal resize the panel region is recomputed, the placeholder rows are re-read (the grid size can change), and the current frame is repainted

## Embedding in your own Ink app

kitty-player exports a `Video` component with an API shaped like the HTML5
`<video>` element. Mount it anywhere in your Ink tree. It sizes itself to
`width` x `height` terminal cells and letterboxes the video inside that box.
No setup call is needed. The component never reads stdin, so it cannot fight
Ink for input.

```tsx
import { render, Text, useInput } from 'ink';
import { useRef } from 'react';
import { Video } from 'kitty-player';
import type { VideoRef } from 'kitty-player';

const App = () => {
  const video = useRef<VideoRef>(null);

  useInput((input) => {
    if (input === ' ') {
      if (video.current?.paused) {
        void video.current.play();
      } else {
        video.current?.pause();
      }
    }
  });

  return (
    <Video ref={video} src="cat.mp4" width={40} height={12} autoPlay loop controls>
      <Text dimColor>video needs kitty graphics support</Text>
    </Video>
  );
};

render(<App />);
```

The children render when the terminal cannot display video, exactly like the
inner content of an HTML5 `<video>` tag. `srcObject` accepts any
`FrameSource` implementation instead of a file path. Events (`onTimeUpdate`,
`onLoadedMetadata`, `onEnded`, `onPlay`, `onPause`, `onError`) and the ref
handle (`play()`, `pause()`, `currentTime`, `paused`, `ended`, `duration`,
`videoWidth`, `videoHeight`) follow the DOM element, with times in seconds.

Hosts that need full control (a custom Screen, non-Ink renderers) can keep
creating resources themselves and pass `screen`, `source`, and `info`, the
way the CLI does.

## Library use

The package also exports the pieces for embedding a video panel in your own Ink app: `Video` (the primary export, with `Player` kept as a backwards-compatible alias), the `FrameSource`/`FrameSourceInfo` contract, `createProceduralSource`, `createFfmpegSource`, `computePanelRegion`, and `formatTime`.

```tsx
import { render } from 'ink';
import { createScreen } from 'kitty-motion';
import { computePanelRegion, createProceduralSource, Video } from 'kitty-player';

const source = createProceduralSource();
const info = await source.open();

const region = computePanelRegion({
  termCols: process.stdout.columns,
  termRows: process.stdout.rows,
  sourceWidth: info.width,
  sourceHeight: info.height,
});

// Create the Screen before rendering Ink. createScreen probes the terminal
// through stdin, and Ink's useInput takes stdin after render().
const screen = await createScreen({
  output: process.stdout,
  sourceWidth: info.width,
  sourceHeight: info.height,
  colorSpace: info.colorSpace,
  placement: 'unicode',
  embedded: true,
  region,
  autoResize: false,
  autoDispose: false,
});

render(
  <Video screen={screen} source={source} info={info} autoPlay loop controls keyboard title help />,
  { exitOnCtrlC: false },
);
```

`FrameSource` is the seam a real decoder implements. `open()` returns the stream info (pixel dimensions, color space, duration, frame rate). `getFrameAt(timeMs)` resolves the frame at or nearest after that timestamp, or `null` to keep the last frame on screen, and the returned buffer is only valid until the next call because sources may reuse it. `seek(timeMs)` repositions the source so nearby `getFrameAt` calls are cheap (a no-op for random-access sources). `close()` releases decoder resources and is idempotent. `createFfmpegSource` implements those four methods over a bundled ffmpeg pipe, and is the FrameSource behind file playback.

## License

MIT
