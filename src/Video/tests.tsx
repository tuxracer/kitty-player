import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import type { FrameSourceInfo } from '../frameSource/index.ts';
import { createProceduralSource } from '../proceduralSource/index.ts';
import { PAUSE_GLYPH, PLAY_GLYPH, Player, Video } from './index.tsx';
import type { PlayerScreen } from './index.tsx';

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

const setup = async (): Promise<{
  harness: FakeScreenHarness;
  source: ReturnType<typeof createProceduralSource>;
  info: FrameSourceInfo;
}> => {
  const source = createProceduralSource({ width: 8, height: 4, durationMs: 20_000 });
  const info = await source.open();
  return { harness: createFakeScreen(), source, info };
};

describe('Player', () => {
  it('renders the placeholder rows and the time text', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, unmount } = render(
      <Player screen={harness.screen} source={source} info={info} autoPlay />,
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
      <Player screen={harness.screen} source={source} info={info} autoPlay />,
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
      <Player screen={harness.screen} source={source} info={info} autoPlay />,
    );
    await flush();

    expect(harness.pushedFrames.length).toBeGreaterThanOrEqual(1);

    unmount();
  });

  it('seeks forward on right arrow and updates the time text', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, stdin, unmount } = render(
      <Player screen={harness.screen} source={source} info={info} autoPlay />,
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
      <Player screen={harness.screen} source={source} info={info} autoPlay />,
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
      <Video screen={harness.screen} source={source} info={info} />,
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
      <Video screen={harness.screen} source={source} info={info} autoPlay onEnded={onEnded} />,
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
