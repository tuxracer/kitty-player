# kitty-media-player

A terminal media player for video and audio files. The UI (title, progress bar, controls) is an [Ink](https://github.com/vadimdemedes/ink) app, and the video pixels are rendered by [kitty-motion](https://github.com/tuxracer/kitty-motion) through Kitty graphics Unicode placeholders. The placeholder cells are ordinary text that Ink lays out, so the picture and the React-driven UI share the terminal without stepping on each other.

## Requirements

- Node.js >= 24
- An interactive [Kitty](https://sw.kovidgoyal.net/kitty/) or [Ghostty](https://ghostty.org/) terminal outside tmux or GNU screen. Other
  interactive terminals get an offer to play in a reduced fallback mode
  without on-screen controls (see the `--fallback` and `--render-mode` flags).
  When stdout is not a TTY it prints a notice and exits without drawing
- ffmpeg is bundled (via ffmpeg-static and ffprobe-static), no system install needed

## Install and run

```sh
npx kitty-media-player
npx kitty-media-player movie.mp4
npx kitty-media-player song.mp3
npx kitty-media-player https://example.com/movie.mp4
```

Or install globally:

```sh
npm install -g kitty-media-player
kitty-media-player
```

For development from a checkout:

```sh
pnpm install
pnpm dev
```

## Current status

kitty-media-player plays video files (`kitty-media-player movie.mp4`) and http(s)
URLs (`kitty-media-player https://example.com/movie.mp4`) through a bundled ffmpeg,
decoded as a stream at a capped resolution with seek and pause. Files play
their audio track too, through a second bundled ffmpeg process and a native
audio device (audify/RtAudio), and degrade to silent video when no audio
output device is available.
Audio-only files (mp3, ogg, flac, and anything else ffmpeg decodes) play
too, showing their embedded cover art when they have one or a live waveform
oscilloscope when they do not.
Running with no arguments plays the built-in
procedural demo clip, a hue-cycling ball moving on a Lissajous path over a
20 second loop (silent, it has no audio track).

## Controls

| Key              | Action                |
| ---------------- | --------------------- |
| space            | play or pause         |
| left/right arrow | seek 5 seconds        |
| m                | mute or unmute audio  |
| q or Ctrl-C      | quit                  |

## CLI flags

| Flag                   | Action                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<file>` or `<url>`    | play this video or audio file or http(s) URL (optional, plays the built-in demo when omitted)                                                                                                                                    |
| `-h`, `--help`         | print help and exit                                                                                                                                                                                                              |
| `-v`, `--version`      | print the version and exit                                                                                                                                                                                                       |
| `--fallback`           | play without the Ink UI using the best available renderer (kitty graphics without controls when supported, otherwise a cell renderer)                                                                                            |
| `--muted`              | start playback with audio muted (the m key toggles it back)                                                                                                                                                                      |
| `--render-mode <mode>` | force a render mode: kitty, half-block, cell-background, emoji, or ascii (kitty alone forces the full player, cell modes force the fallback player, and `--fallback --render-mode kitty` forces kitty graphics without controls) |

## How it works

The technical details (startup sequence, rendering path, playback clock, the
`FrameSource` contract, module map) are in [docs/TRD.md](docs/TRD.md).

## Embedding in your own Ink app

kitty-media-player exports a `Video` component with an API shaped like the HTML5
`<video>` element. Mount it anywhere in your Ink tree. It sizes itself to
`width` x `height` terminal cells and letterboxes the video inside that box.
No setup call is needed. The component never reads stdin, so it cannot fight
Ink for input.

```tsx
import { render, Text, useInput } from 'ink';
import { useRef } from 'react';
import { Video } from 'kitty-media-player';
import type { VideoRef } from 'kitty-media-player';

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

Beyond `Video`, the package exports the underlying pieces: the
`FrameSource`/`FrameSourceInfo` contract, `createProceduralSource`,
`createFfmpegSource`, `computePanelRegion`, `formatTime`, and the audio
pieces, `createFfmpegAudioPlayer` and the `AudioPlayer`/`AudioPlayerInfo`
contract.

Hosts that need full control (a custom probed Screen, non-Ink renderers) can
create the resources themselves and pass `screen`, `source`, and `info`, the
way the CLI does. That mode is documented in [docs/TRD.md](docs/TRD.md). `createFfmpegSource` implements those four methods over a bundled ffmpeg pipe, and is the FrameSource behind file playback.

## License

MIT
