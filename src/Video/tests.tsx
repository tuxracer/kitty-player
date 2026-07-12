import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AudioPlayer } from '../audioPlayer/index.ts';
import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';
import { createProceduralSource } from '../proceduralSource/index.ts';
import {
  DRIFT_RESYNC_THRESHOLD_MS,
  HELP_TEXT,
  isVideoError,
  PAUSE_GLYPH,
  PLAY_GLYPH,
  PLAYER_TITLE,
  SEEK_STEP_MS,
  Video,
} from './index.tsx';
import type { PlayerScreen, VideoRef } from './index.tsx';

const managedScreenMocks = vi.hoisted(() => ({
  canDisplayVideo: vi.fn((): boolean => true),
  createManagedScreen: vi.fn(),
}));

vi.mock('./managedScreen.ts', () => managedScreenMocks);

// Let queued microtasks and immediates settle (getFrameAt/seek promise chains)
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
};

const delay = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface FakeScreenHarness {
  screen: PlayerScreen;
  pushedFrames: Uint8Array[];
  setRegionCalls: number;
  disposeCalls: number;
}

const createFakeScreen = (): FakeScreenHarness => {
  const harness: FakeScreenHarness = {
    pushedFrames: [],
    setRegionCalls: 0,
    disposeCalls: 0,
    screen: {
      getPlaceholderRows: () => ['row0', 'row1'],
      pushFrame: (frame) => {
        harness.pushedFrames.push(frame);
      },
      setRegion: () => {
        harness.setRegionCalls += 1;
      },
      isWritable: () => true,
      dispose: () => {
        harness.disposeCalls += 1;
      },
    },
  };
  return harness;
};

interface FakeSourceHarness {
  source: FrameSource;
  seeks: number[];
}

const createFakeSource = (info: FrameSourceInfo): FakeSourceHarness => {
  const harness: FakeSourceHarness = {
    seeks: [],
    source: {
      open: () => Promise.resolve(info),
      getFrameAt: () => Promise.resolve(new Uint8Array(info.width * info.height * 3)),
      seek: (timeMs) => {
        harness.seeks.push(timeMs);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
  };
  return harness;
};

interface FakeAudioHarness {
  audio: AudioPlayer;
  playFroms: number[];
  pauseCalls: number;
  mutedValues: boolean[];
  closeCalls: number;
  positionMs: number | null;
}

const createFakeAudio = (): FakeAudioHarness => {
  const harness: FakeAudioHarness = {
    playFroms: [],
    pauseCalls: 0,
    mutedValues: [],
    closeCalls: 0,
    positionMs: null,
    audio: {
      open: () => Promise.resolve({ hasAudio: true }),
      playFrom: (timeMs) => {
        harness.playFroms.push(timeMs);
      },
      pause: () => {
        harness.pauseCalls += 1;
      },
      setMuted: (muted) => {
        harness.mutedValues.push(muted);
      },
      getPositionMs: () => harness.positionMs,
      close: () => {
        harness.closeCalls += 1;
        return Promise.resolve();
      },
    },
  };
  return harness;
};

const setup = async (): Promise<{
  harness: FakeScreenHarness;
  source: ReturnType<typeof createProceduralSource>;
  info: FrameSourceInfo;
}> => {
  const source = createProceduralSource({ width: 8, height: 4, durationMs: 20_000 });
  const info = await source.open();
  return { harness: createFakeScreen(), source, info };
};

describe('Video', () => {
  it('renders the placeholder rows and the time text', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} autoPlay keyboard controls />,
    );
    await flush();

    const frame = lastFrame();
    expect(frame).toContain('row0');
    expect(frame).toContain('row1');
    expect(frame).toContain('0:00');
    expect(frame).toContain('0:20');
    expect(frame).toContain(PLAY_GLYPH);

    unmount();
  });

  it('toggles the pause glyph on space', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, stdin, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} autoPlay keyboard controls />,
    );
    await flush();
    expect(lastFrame()).toContain(PLAY_GLYPH);

    stdin.write(' ');
    await flush();
    expect(lastFrame()).toContain(PAUSE_GLYPH);

    stdin.write(' ');
    await flush();
    expect(lastFrame()).toContain(PLAY_GLYPH);

    unmount();
  });

  it('pushes the initial frame to the screen', async () => {
    const { harness, source, info } = await setup();
    const { unmount } = render(
      <Video screen={harness.screen} source={source} info={info} autoPlay keyboard controls />,
    );
    await flush();

    expect(harness.pushedFrames.length).toBeGreaterThanOrEqual(1);

    unmount();
  });

  it('seeks forward on right arrow and updates the time text', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, stdin, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} autoPlay keyboard controls />,
    );
    await flush();

    stdin.write('\u001B[C'); // right arrow
    await flush();
    expect(lastFrame()).toContain('0:05 / 0:20');

    unmount();
  });

  it('stops pushing frames after unmount', async () => {
    const { harness, source, info } = await setup();
    const { unmount } = render(
      <Video screen={harness.screen} source={source} info={info} autoPlay keyboard controls />,
    );
    await flush();

    unmount();
    await flush(); // let any in-flight frame settle
    const pushedAfterUnmount = harness.pushedFrames.length;

    // At 30fps a live interval would push roughly three frames in 100ms
    await delay(100);
    expect(harness.pushedFrames.length).toBe(pushedAfterUnmount);
  });
});

describe('Video playback semantics', () => {
  it('mounts paused on the first frame without autoPlay', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} controls />,
    );
    await flush();

    // First frame is shown even while paused
    expect(harness.pushedFrames.length).toBeGreaterThanOrEqual(1);
    expect(lastFrame()).toContain(PAUSE_GLYPH);

    unmount();
  });

  it('fires onLoadedMetadata with dimensions and duration in seconds', async () => {
    const { harness, source, info } = await setup();
    const onLoadedMetadata = vi.fn();
    const { unmount } = render(
      <Video
        screen={harness.screen}
        source={source}
        info={info}
        onLoadedMetadata={onLoadedMetadata}
      />,
    );
    await flush();

    expect(onLoadedMetadata).toHaveBeenCalledWith({
      videoWidth: 8,
      videoHeight: 4,
      duration: 20,
    });

    unmount();
  });

  it('fires onTimeUpdate in seconds when the displayed second changes', async () => {
    const { harness, source, info } = await setup();
    const onTimeUpdate = vi.fn();
    const { stdin, unmount } = render(
      <Video
        screen={harness.screen}
        source={source}
        info={info}
        autoPlay
        keyboard
        controls
        onTimeUpdate={onTimeUpdate}
      />,
    );
    await flush();

    stdin.write('\u001B[C'); // right arrow seeks +5s, crossing a second boundary
    await flush();

    expect(onTimeUpdate).toHaveBeenCalledWith({ currentTime: 5, duration: 20 });

    unmount();
  });

  it('fires onPause and onPlay when space toggles playback', async () => {
    const { harness, source, info } = await setup();
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const { stdin, unmount } = render(
      <Video
        screen={harness.screen}
        source={source}
        info={info}
        autoPlay
        keyboard
        controls
        onPlay={onPlay}
        onPause={onPause}
      />,
    );
    await flush();

    stdin.write(' ');
    await flush();
    expect(onPause).toHaveBeenCalledTimes(1);

    stdin.write(' ');
    await flush();
    expect(onPlay).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('stops at the end and fires onEnded when loop is false', async () => {
    const source = createProceduralSource({ width: 8, height: 4, durationMs: 100 });
    const info = await source.open();
    const harness = createFakeScreen();
    const onEnded = vi.fn();
    const { lastFrame, unmount } = render(
      <Video
        screen={harness.screen}
        source={source}
        info={info}
        autoPlay
        keyboard
        controls
        onEnded={onEnded}
      />,
    );

    // 100ms duration at 30fps ends within a few ticks
    await delay(300);
    await flush();

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain(PAUSE_GLYPH);

    unmount();
  });

  it('wraps around and never fires onEnded when loop is true', async () => {
    const source = createProceduralSource({ width: 8, height: 4, durationMs: 100 });
    const info = await source.open();
    const harness = createFakeScreen();
    const onEnded = vi.fn();
    const { lastFrame, unmount } = render(
      <Video
        screen={harness.screen}
        source={source}
        info={info}
        autoPlay
        loop
        keyboard
        controls
        onEnded={onEnded}
      />,
    );

    await delay(300);
    await flush();

    expect(onEnded).not.toHaveBeenCalled();
    expect(lastFrame()).toContain(PLAY_GLYPH);

    unmount();
  });
});

describe('Video chrome and keyboard gating', () => {
  it('renders only the video rows by default', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} />,
    );
    await flush();

    const frame = lastFrame();
    expect(frame).toContain('row0');
    expect(frame).not.toContain(PLAYER_TITLE.trim());
    expect(frame).not.toContain(HELP_TEXT);
    expect(frame).not.toContain(PAUSE_GLYPH);
    expect(frame).not.toContain('0:00');

    unmount();
  });

  it('ignores keys unless keyboard is set', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, stdin, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} autoPlay controls />,
    );
    await flush();
    expect(lastFrame()).toContain(PLAY_GLYPH);

    stdin.write(' ');
    await flush();
    expect(lastFrame()).toContain(PLAY_GLYPH);

    unmount();
  });

  it('shows title and help when requested', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} title help />,
    );
    await flush();

    const frame = lastFrame();
    expect(frame).toContain(PLAYER_TITLE.trim());
    expect(frame).toContain(HELP_TEXT);

    unmount();
  });
});

describe('VideoRef', () => {
  const INFO: FrameSourceInfo = {
    width: 8,
    height: 4,
    colorSpace: 'rgb24',
    durationMs: 20_000,
    fps: 30,
  };

  it('exposes HTML5-shaped getters', async () => {
    const harness = createFakeScreen();
    const fake = createFakeSource(INFO);
    const ref = createRef<VideoRef>();
    const { unmount } = render(
      <Video ref={ref} screen={harness.screen} source={fake.source} info={INFO} />,
    );
    await flush();

    expect(ref.current?.paused).toBe(true);
    expect(ref.current?.ended).toBe(false);
    expect(ref.current?.duration).toBe(20);
    expect(ref.current?.videoWidth).toBe(8);
    expect(ref.current?.videoHeight).toBe(4);
    expect(ref.current?.currentTime).toBe(0);

    unmount();
  });

  it('play() resolves and starts playback, pause() stops it', async () => {
    const harness = createFakeScreen();
    const fake = createFakeSource(INFO);
    const ref = createRef<VideoRef>();
    const onPlay = vi.fn();
    const onPause = vi.fn();
    const { unmount } = render(
      <Video
        ref={ref}
        screen={harness.screen}
        source={fake.source}
        info={INFO}
        onPlay={onPlay}
        onPause={onPause}
      />,
    );
    await flush();

    await ref.current?.play();
    await flush();
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(ref.current?.paused).toBe(false);

    ref.current?.pause();
    await flush();
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(ref.current?.paused).toBe(true);

    unmount();
  });

  it('setting currentTime seeks in seconds', async () => {
    const harness = createFakeScreen();
    const fake = createFakeSource(INFO);
    const ref = createRef<VideoRef>();
    const { unmount } = render(
      <Video ref={ref} screen={harness.screen} source={fake.source} info={INFO} />,
    );
    await flush();

    if (ref.current) {
      ref.current.currentTime = 5;
    }
    await flush();

    expect(fake.seeks).toContain(5_000);
    expect(ref.current?.currentTime).toBe(5);

    unmount();
  });
});

describe('Video self-managed mode', () => {
  const INFO: FrameSourceInfo = {
    width: 1920,
    height: 1080,
    colorSpace: 'rgb24',
    durationMs: 20_000,
    fps: 30,
  };

  beforeEach(() => {
    managedScreenMocks.canDisplayVideo.mockReturnValue(true);
    managedScreenMocks.createManagedScreen.mockReset();
  });

  it('opens the srcObject, creates a letterboxed screen, and renders its rows', async () => {
    const harness = createFakeScreen();
    managedScreenMocks.createManagedScreen.mockReturnValue(harness.screen);
    const fake = createFakeSource(INFO);
    const onLoadedMetadata = vi.fn();
    const { lastFrame, unmount } = render(
      <Video srcObject={fake.source} width={40} height={12} onLoadedMetadata={onLoadedMetadata} />,
    );
    await flush();

    expect(lastFrame()).toContain('row0');
    expect(onLoadedMetadata).toHaveBeenCalledWith({
      videoWidth: 1920,
      videoHeight: 1080,
      duration: 20,
    });
    // 1920x1080 in a 40x12 box aspect-fits to 40x11 (see computeEmbeddedRegion tests)
    expect(managedScreenMocks.createManagedScreen).toHaveBeenCalledWith({
      region: { offsetCol: 1, offsetRow: 1, cols: 40, rows: 11 },
      sourceWidth: 1920,
      sourceHeight: 1080,
      colorSpace: 'rgb24',
    });

    unmount();
  });

  it('renders children and never opens the source when the terminal is unsupported', async () => {
    managedScreenMocks.canDisplayVideo.mockReturnValue(false);
    const open = vi.fn();
    const source: FrameSource = {
      open,
      getFrameAt: () => Promise.resolve(null),
      seek: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const { lastFrame, unmount } = render(
      <Video srcObject={source} width={40} height={12}>
        <Text>no video here</Text>
      </Video>,
    );
    await flush();

    expect(lastFrame()).toContain('no video here');
    expect(open).not.toHaveBeenCalled();

    unmount();
  });

  it('disposes the screen and closes the source on unmount', async () => {
    const harness = createFakeScreen();
    managedScreenMocks.createManagedScreen.mockReturnValue(harness.screen);
    const close = vi.fn(() => Promise.resolve());
    const fake = createFakeSource(INFO);
    const source: FrameSource = { ...fake.source, close };
    const { unmount } = render(<Video srcObject={source} width={40} height={12} />);
    await flush();

    unmount();
    await flush();

    expect(harness.disposeCalls).toBe(1);
    expect(close).toHaveBeenCalled();
  });

  it('reports a typed error and renders children when no source prop is given', async () => {
    const onError = vi.fn();
    const { lastFrame, unmount } = render(
      <Video width={40} height={12} onError={onError}>
        <Text>broken</Text>
      </Video>,
    );
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    const error: unknown = onError.mock.calls[0]?.[0];
    expect(isVideoError(error) && error.code === 'INVALID_SRC').toBe(true);
    expect(lastFrame()).toContain('broken');

    unmount();
  });

  it('reports open failures through onError and renders children', async () => {
    const failure = new Error('probe failed');
    const source: FrameSource = {
      open: () => Promise.reject(failure),
      getFrameAt: () => Promise.resolve(null),
      seek: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const onError = vi.fn();
    const { lastFrame, unmount } = render(
      <Video srcObject={source} width={40} height={12} onError={onError}>
        <Text>broken</Text>
      </Video>,
    );
    await flush();

    expect(onError).toHaveBeenCalledWith(failure);
    expect(lastFrame()).toContain('broken');

    unmount();
  });

  it('recomputes the region when width or height props change', async () => {
    const harness = createFakeScreen();
    managedScreenMocks.createManagedScreen.mockReturnValue(harness.screen);
    const fake = createFakeSource(INFO);
    const { rerender, unmount } = render(
      <Video srcObject={fake.source} width={40} height={12} />,
    );
    await flush();
    const callsBefore = harness.setRegionCalls;

    rerender(<Video srcObject={fake.source} width={40} height={8} />);
    await flush();

    expect(harness.setRegionCalls).toBeGreaterThan(callsBefore);

    unmount();
  });
});

describe('Video audio wiring', () => {
  it('starts audio from zero on autoPlay mount and pauses it on unmount', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const { unmount } = render(
      <Video screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay keyboard />,
    );
    await flush();
    expect(audio.playFroms[0]).toBe(0);
    unmount();
    // Effect cleanup (where the pause call lives) is a passive effect, so it
    // is not flushed synchronously by Ink's unmount(); matches the flush
    // after unmount() already used elsewhere in this file (e.g. "disposes
    // the screen and closes the source on unmount").
    await flush();
    expect(audio.pauseCalls).toBeGreaterThanOrEqual(1);
  });

  it('pauses audio on space and resumes from the playhead', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const { stdin, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay keyboard />,
    );
    await flush();
    const pausesBefore = audio.pauseCalls;
    stdin.write(' ');
    await flush();
    expect(audio.pauseCalls).toBe(pausesBefore + 1);
    const playsBefore = audio.playFroms.length;
    stdin.write(' ');
    await flush();
    expect(audio.playFroms.length).toBe(playsBefore + 1);
    unmount();
  });

  it('restarts audio at the seek target while playing', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const { stdin, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay keyboard />,
    );
    await flush();
    stdin.write('\u001B[C'); // right arrow
    await flush();
    expect(audio.playFroms.at(-1)).toBeGreaterThanOrEqual(SEEK_STEP_MS);
    unmount();
  });

  it('does not restart audio when seeking while paused', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const { stdin, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay keyboard />,
    );
    await flush();
    stdin.write(' ');
    await flush();
    const playsBefore = audio.playFroms.length;
    stdin.write('\u001B[C'); // right arrow
    await flush();
    expect(audio.playFroms.length).toBe(playsBefore);
    unmount();
  });

  it('snaps audio back to the clock when drift exceeds the threshold', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const { unmount } = render(
      <Video screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay keyboard />,
    );
    await flush();
    const playsBefore = audio.playFroms.length;
    // Report a position far beyond any real playhead, the next whole-second
    // boundary must snap audio back to the clock time
    audio.positionMs = 60_000;
    await delay(1_300);
    await flush();
    expect(audio.playFroms.length).toBeGreaterThan(playsBefore);
    expect(audio.playFroms.at(-1)).toBeLessThan(60_000 - DRIFT_RESYNC_THRESHOLD_MS);
    unmount();
  });

  it('leaves audio alone when drift stays under the threshold', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const { unmount } = render(
      <Video screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay keyboard />,
    );
    await flush();
    const playsBefore = audio.playFroms.length;
    // Track the clock closely: recompute a near-playhead position on demand
    audio.positionMs = 0;
    const tracker = setInterval(() => {
      audio.positionMs = (audio.positionMs ?? 0) + 100;
    }, 100);
    await delay(1_300);
    clearInterval(tracker);
    await flush();
    expect(audio.playFroms.length).toBe(playsBefore);
    unmount();
  });

  it('closes the audio player on quit', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const { stdin, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay keyboard />,
    );
    await flush();
    stdin.write('q');
    await flush();
    expect(audio.closeCalls).toBe(1);
    unmount();
  });

  it('never starts audio when an onPlay handler synchronously pauses the clock', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const ref = createRef<VideoRef>();
    const { unmount } = render(
      <Video
        ref={ref}
        screen={harness.screen}
        source={source}
        info={info}
        audio={audio.audio}
        onPlay={() => {
          // A host callback re-entering the clock synchronously: the trailing
          // playFrom in play() must observe the paused state and not fire
          ref.current?.pause();
        }}
      />,
    );
    await flush();
    void ref.current?.play();
    await flush();
    expect(audio.playFroms).toEqual([]);
    expect(audio.pauseCalls).toBeGreaterThanOrEqual(1);
    unmount();
  });
});

describe('Video mute', () => {
  it('applies the initial muted prop to the audio player', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const { unmount } = render(
      <Video screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay keyboard muted />,
    );
    await flush();
    expect(audio.mutedValues[0]).toBe(true);
    unmount();
  });

  it('toggles mute on the m key', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const { stdin, unmount } = render(
      <Video screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay keyboard />,
    );
    await flush();
    expect(audio.mutedValues.at(-1)).toBe(false);
    stdin.write('m');
    await flush();
    expect(audio.mutedValues.at(-1)).toBe(true);
    stdin.write('m');
    await flush();
    expect(audio.mutedValues.at(-1)).toBe(false);
    unmount();
  });

  it('exposes muted on the ref handle, get and set', async () => {
    const { harness, source, info } = await setup();
    const audio = createFakeAudio();
    const ref = createRef<VideoRef>();
    const { unmount } = render(
      <Video ref={ref} screen={harness.screen} source={source} info={info} audio={audio.audio} autoPlay />,
    );
    await flush();
    expect(ref.current?.muted).toBe(false);
    if (ref.current) {
      ref.current.muted = true;
    }
    await flush();
    expect(ref.current?.muted).toBe(true);
    expect(audio.mutedValues.at(-1)).toBe(true);
    unmount();
  });
});
