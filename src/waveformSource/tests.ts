import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import ffmpegPath from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FrameSource } from '../frameSource/index.ts';
import {
  RGB_CHANNELS,
  TRACE_RGB,
  WAVEFORM_FPS,
  WAVEFORM_HEIGHT,
  WAVEFORM_WIDTH,
  createWaveformSource,
} from './index.ts';

const execFileAsync = promisify(execFile);

let fixtureDir: string;
let toneMp3: string;
let silenceMp3: string;

const DURATION_MS = 2_000;
const FIXTURE_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  if (ffmpegPath === null) {
    throw new Error('ffmpeg-static provides no binary for this platform');
  }
  fixtureDir = await mkdtemp(join(tmpdir(), 'kitty-media-player-waveform-'));
  toneMp3 = join(fixtureDir, 'tone.mp3');
  silenceMp3 = join(fixtureDir, 'silence.mp3');
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-af', 'volume=6', toneMp3,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '2', silenceMp3,
  ]);
}, FIXTURE_TIMEOUT_MS);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

/** Polls getFrameAt until the decode catches up (it is null before then) */
const waitForFrame = async (source: FrameSource, timeMs: number): Promise<Uint8Array> => {
  const deadlineMs = Date.now() + 5_000;
  while (Date.now() < deadlineMs) {
    const frame = await source.getFrameAt(timeMs);
    if (frame !== null) {
      return Uint8Array.from(frame);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no frame arrived at ${timeMs}ms within 5s`);
};

const waitForCondition = async (condition: () => boolean): Promise<void> => {
  const deadlineMs = Date.now() + 5_000;
  while (Date.now() < deadlineMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met within 5s');
};

const isTracePixel = (frame: Uint8Array, x: number, y: number): boolean => {
  const offset = (y * WAVEFORM_WIDTH + x) * RGB_CHANNELS;
  return (
    frame[offset] === TRACE_RGB[0] &&
    frame[offset + 1] === TRACE_RGB[1] &&
    frame[offset + 2] === TRACE_RGB[2]
  );
};

/** Largest distance from the horizontal centerline at which any trace pixel sits */
const maxTraceOffset = (frame: Uint8Array): number => {
  const centerY = WAVEFORM_HEIGHT / 2;
  let max = 0;
  for (let y = 0; y < WAVEFORM_HEIGHT; y++) {
    for (let x = 0; x < WAVEFORM_WIDTH; x++) {
      if (isTracePixel(frame, x, y)) {
        max = Math.max(max, Math.abs(y - centerY));
      }
    }
  }
  return max;
};

describe('createWaveformSource', () => {
  it('opens with the canvas dimensions, rgb24, the audio duration, and the waveform fps', async () => {
    const source = createWaveformSource({ filePath: toneMp3, durationMs: DURATION_MS });
    const info = await source.open();
    expect(info.width).toBe(WAVEFORM_WIDTH);
    expect(info.height).toBe(WAVEFORM_HEIGHT);
    expect(info.colorSpace).toBe('rgb24');
    expect(info.durationMs).toBe(DURATION_MS);
    expect(info.fps).toBe(WAVEFORM_FPS);
    expect(info.hasAudio).toBe(true);
    await source.close();
  });

  it('draws tall spans for a loud tone', async () => {
    const source = createWaveformSource({ filePath: toneMp3, durationMs: DURATION_MS });
    await source.open();
    const frame = await waitForFrame(source, 500);
    expect(frame.length).toBe(WAVEFORM_WIDTH * WAVEFORM_HEIGHT * RGB_CHANNELS);
    expect(maxTraceOffset(frame)).toBeGreaterThan(40);
    await source.close();
  });

  it('draws a flat centerline for silence', async () => {
    const source = createWaveformSource({ filePath: silenceMp3, durationMs: DURATION_MS });
    await source.open();
    const frame = await waitForFrame(source, 500);
    // Every column still draws its centerline pixel
    const centerY = WAVEFORM_HEIGHT / 2;
    expect(isTracePixel(frame, 0, centerY)).toBe(true);
    expect(isTracePixel(frame, WAVEFORM_WIDTH - 1, centerY)).toBe(true);
    expect(maxTraceOffset(frame)).toBeLessThanOrEqual(1);
    await source.close();
  });

  it('stops reporting buffering once the decode is ahead of the playhead', async () => {
    const source = createWaveformSource({ filePath: toneMp3, durationMs: DURATION_MS });
    await source.open();
    await waitForCondition(() => !(source.isBuffering?.() ?? false));
    await expect(source.getFrameAt(0)).resolves.not.toBeNull();
    await source.close();
    expect(source.isBuffering?.()).toBe(false);
  });

  it('serves frames after a seek, and the window moves with the playhead', async () => {
    const source = createWaveformSource({ filePath: toneMp3, durationMs: DURATION_MS });
    await source.open();
    const early = await waitForFrame(source, 100);
    // 1337 ms keeps the 440 Hz phase offset non-integral (440 Hz x 1.4 s
    // would be exactly 616 cycles, rendering an identical trace)
    await source.seek(1_337);
    const late = await waitForFrame(source, 1_337);
    expect(late.length).toBe(early.length);
    expect(late).not.toEqual(early);
    await source.close();
  });

  it('resolves null after close, and close is idempotent', async () => {
    const source = createWaveformSource({ filePath: toneMp3, durationMs: DURATION_MS });
    await source.open();
    await source.close();
    await expect(source.getFrameAt(0)).resolves.toBeNull();
    await expect(source.close()).resolves.toBeUndefined();
  });
});
