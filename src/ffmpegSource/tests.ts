import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import ffmpegPath from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FrameSource } from '../frameSource/index.ts';
import {
  FfmpegSourceError,
  MAX_DECODE_HEIGHT,
  MAX_DECODE_WIDTH,
  RGB_CHANNELS,
  computeDecodeSize,
  createFfmpegSource,
  isFfmpegSourceError,
  probeFile,
} from './index.ts';
import type { FfmpegSourceErrorCode } from './index.ts';

const execFileAsync = promisify(execFile);

// Real fixture videos generated once per run with the bundled ffmpeg, so the
// suite exercises the actual probe/decode pipeline with no mocks.
let fixtureDir: string;
let smallVideo: string;
let largeVideo: string;
let audioOnly: string;
let notVideo: string;
let rotatedVideo: string;
let noDurationVideo: string;

const FIXTURE_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  if (ffmpegPath === null) {
    throw new Error('ffmpeg-static provides no binary for this platform');
  }
  fixtureDir = await mkdtemp(join(tmpdir(), 'kitty-video-player-ffmpeg-'));
  smallVideo = join(fixtureDir, 'small.mp4');
  largeVideo = join(fixtureDir, 'large.mp4');
  audioOnly = join(fixtureDir, 'audio-only.m4a');
  notVideo = join(fixtureDir, 'not-a-video.txt');
  rotatedVideo = join(fixtureDir, 'rotated.mp4');
  noDurationVideo = join(fixtureDir, 'no-duration.mkv');
  const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x36:rate=10', ...encode, smallVideo,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=1920x1080:rate=10', ...encode, largeVideo,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioOnly,
  ]);
  await writeFile(notVideo, 'this is not a media file\n');

  const rotatedSource = join(fixtureDir, 'rotated-source.mp4');
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x36:rate=10', ...encode, rotatedSource,
  ]);
  await execFileAsync(ffmpegPath, [
    '-display_rotation', '90', '-i', rotatedSource, '-c', 'copy', rotatedVideo,
  ]);

  // Live-mode matroska writes no duration header, matching what browser
  // recorders and screen capture tools produce (webm shares the muxer)
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x36:rate=10', ...encode,
    '-f', 'matroska', '-live', '1', noDurationVideo,
  ]);
}, FIXTURE_TIMEOUT_MS);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

const expectCode = async (
  promise: Promise<unknown>,
  code: FfmpegSourceErrorCode,
): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    expect(isFfmpegSourceError(error)).toBe(true);
    if (isFfmpegSourceError(error)) {
      expect(error.code).toBe(code);
    }
    return;
  }
  throw new Error(`expected a rejection with code ${code}`);
};

describe('FfmpegSourceError', () => {
  it('is identified by the isFfmpegSourceError guard', () => {
    const error = new FfmpegSourceError('FILE_NOT_FOUND', 'missing.mp4: no such file');
    expect(isFfmpegSourceError(error)).toBe(true);
    expect(error.code).toBe('FILE_NOT_FOUND');
    expect(error.message).toBe('missing.mp4: no such file');
    expect(error.name).toBe('FfmpegSourceError');
  });

  it('rejects plain errors and non-errors', () => {
    expect(isFfmpegSourceError(new Error('FILE_NOT_FOUND'))).toBe(false);
    expect(isFfmpegSourceError('FILE_NOT_FOUND')).toBe(false);
    expect(isFfmpegSourceError(null)).toBe(false);
  });
});

describe('computeDecodeSize', () => {
  it('downscales 1920x1080 to the 960x540 cap', () => {
    expect(computeDecodeSize(1920, 1080)).toEqual({ width: 960, height: 540 });
  });

  it('keeps sources already under the cap at native size', () => {
    expect(computeDecodeSize(640, 360)).toEqual({ width: 640, height: 360 });
  });

  it('never upscales small sources', () => {
    expect(computeDecodeSize(64, 36)).toEqual({ width: 64, height: 36 });
  });

  it('fits tall sources by height and preserves the aspect ratio', () => {
    // scale = 540/1920, width 1080 * scale = 303.75, rounded to even
    expect(computeDecodeSize(1080, 1920)).toEqual({ width: 304, height: 540 });
  });

  it('rounds fitted dimensions to even numbers', () => {
    // scale = 960/963, height 541 * scale = 539.3, rounded to even
    expect(computeDecodeSize(963, 541)).toEqual({ width: 960, height: 540 });
  });
});

describe('probeFile', () => {
  it('reads dimensions, duration, and fps from a real video', async () => {
    const probe = await probeFile(smallVideo);
    expect(probe.nativeWidth).toBe(64);
    expect(probe.nativeHeight).toBe(36);
    expect(probe.fps).toBe(10);
    expect(probe.durationMs).toBeGreaterThanOrEqual(1_900);
    expect(probe.durationMs).toBeLessThanOrEqual(2_100);
  });

  it('rejects a missing path with FILE_NOT_FOUND', async () => {
    await expectCode(probeFile(join(fixtureDir, 'missing.mp4')), 'FILE_NOT_FOUND');
  });

  it('rejects a non-media file with PROBE_FAILED', async () => {
    await expectCode(probeFile(notVideo), 'PROBE_FAILED');
  });

  it('rejects an audio-only file with NO_VIDEO_STREAM', async () => {
    await expectCode(probeFile(audioOnly), 'NO_VIDEO_STREAM');
  });

  it('swaps dimensions for quarter-turned rotation metadata', async () => {
    const probe = await probeFile(rotatedVideo);
    expect(probe.nativeWidth).toBe(36);
    expect(probe.nativeHeight).toBe(64);
  });

  it('measures duration when the container header lacks one', async () => {
    const probe = await probeFile(noDurationVideo);
    expect(probe.durationMs).toBeGreaterThanOrEqual(900);
    expect(probe.durationMs).toBeLessThanOrEqual(1_100);
  });
});

// The source reuses buffers, so successful grabs snapshot a copy. Decoding is
// async and getFrameAt never blocks, so poll until the frame lands.
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

describe('createFfmpegSource', () => {
  it('opens with decode dimensions, rgb24, duration, and fps', async () => {
    const source = createFfmpegSource({ filePath: smallVideo });
    const info = await source.open();
    expect(info.width).toBe(64);
    expect(info.height).toBe(36);
    expect(info.colorSpace).toBe('rgb24');
    expect(info.fps).toBe(10);
    expect(info.durationMs).toBeGreaterThanOrEqual(1_900);
    await source.close();
  });

  it('rejects open() for a missing file with FILE_NOT_FOUND', async () => {
    const source = createFfmpegSource({ filePath: join(fixtureDir, 'missing.mp4') });
    await expectCode(source.open(), 'FILE_NOT_FOUND');
  });

  it('serves frames of width * height * 3 bytes that change over time', async () => {
    const source = createFfmpegSource({ filePath: smallVideo });
    const info = await source.open();
    const first = await waitForFrame(source, 0);
    expect(first.length).toBe(info.width * info.height * RGB_CHANNELS);
    const later = await waitForFrame(source, 1_500);
    expect(later).not.toEqual(first);
    await source.close();
  });

  it('downscales large sources to the cap and serves matching buffers', async () => {
    const source = createFfmpegSource({ filePath: largeVideo });
    const info = await source.open();
    expect(info.width).toBe(MAX_DECODE_WIDTH);
    expect(info.height).toBe(MAX_DECODE_HEIGHT);
    const frame = await waitForFrame(source, 0);
    expect(frame.length).toBe(MAX_DECODE_WIDTH * MAX_DECODE_HEIGHT * RGB_CHANNELS);
    await source.close();
  });

  it('returns null past the end of the file', async () => {
    const source = createFfmpegSource({ filePath: smallVideo });
    await source.open();
    // 2 s at 10 fps: the last frame sits at 1900 ms
    await waitForFrame(source, 1_900);
    await expect(source.getFrameAt(3_000)).resolves.toBeNull();
    await source.close();
  });

  it('seek lands on the same frame sequential playback reaches', async () => {
    const source = createFfmpegSource({ filePath: smallVideo });
    await source.open();
    const sequential = await waitForFrame(source, 1_500);
    await source.seek(1_500);
    const sought = await waitForFrame(source, 1_500);
    expect(sought).toEqual(sequential);
    await source.close();
  });

  it('recovers from a backward time jump (the loop-around path)', async () => {
    const source = createFfmpegSource({ filePath: smallVideo });
    await source.open();
    await waitForFrame(source, 1_500);
    const rewound = await waitForFrame(source, 200);

    const fresh = createFfmpegSource({ filePath: smallVideo });
    await fresh.open();
    const expected = await waitForFrame(fresh, 200);
    expect(rewound).toEqual(expected);

    await source.close();
    await fresh.close();
  });

  it('resolves null from getFrameAt after close, and close is idempotent', async () => {
    const source = createFfmpegSource({ filePath: smallVideo });
    await source.open();
    await waitForFrame(source, 0);
    await source.close();
    await expect(source.getFrameAt(0)).resolves.toBeNull();
    await expect(source.close()).resolves.toBeUndefined();
    await expect(source.getFrameAt(100)).resolves.toBeNull();
  });

  it('decodes rotated video at display orientation', async () => {
    const source = createFfmpegSource({ filePath: rotatedVideo });
    const info = await source.open();
    expect(info.width).toBe(36);
    expect(info.height).toBe(64);
    const frame = await waitForFrame(source, 0);
    expect(frame.length).toBe(36 * 64 * RGB_CHANNELS);
    await source.close();
  });
});
