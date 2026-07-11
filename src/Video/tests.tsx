import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import type { FrameSourceInfo } from '../frameSource/index.ts';
import { createProceduralSource } from '../proceduralSource/index.ts';
import { PAUSE_GLYPH, PLAY_GLYPH, Player } from './index.tsx';
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
      <Player screen={harness.screen} source={source} info={info} />,
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
      <Player screen={harness.screen} source={source} info={info} />,
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
      <Player screen={harness.screen} source={source} info={info} />,
    );
    await flush();

    expect(harness.pushedFrames.length).toBeGreaterThanOrEqual(1);

    unmount();
  });

  it('seeks forward on right arrow and updates the time text', async () => {
    const { harness, source, info } = await setup();
    const { lastFrame, stdin, unmount } = render(
      <Player screen={harness.screen} source={source} info={info} />,
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
      <Player screen={harness.screen} source={source} info={info} />,
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
