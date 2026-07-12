import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import ffmpegPath from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FrameSource } from '../frameSource/index.ts';
import { isMediaProbeError } from '../mediaProbe/index.ts';
import type { MediaProbeErrorCode } from '../mediaProbe/index.ts';
import {
  FfmpegSourceError,
  MAX_DECODE_HEIGHT,
  MAX_DECODE_WIDTH,
  RGB_CHANNELS,
  computeDecodeSize,
  createFfmpegSource,
  isFfmpegSourceError,
} from './index.ts';
import type { FfmpegSourceErrorCode } from './index.ts';

const execFileAsync = promisify(execFile);

// Real fixture videos generated once per run with the bundled ffmpeg, so the
// suite exercises the actual probe/decode pipeline with no mocks.
let fixtureDir: string;
let smallVideo: string;
let largeVideo: string;
let audioOnly: string;
let rotatedVideo: string;
let noDurationVideo: string;
let soundVideo: string;

const FIXTURE_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  if (ffmpegPath === null) {
    throw new Error('ffmpeg-static provides no binary for this platform');
  }
  fixtureDir = await mkdtemp(join(tmpdir(), 'kitty-media-player-ffmpeg-'));
  smallVideo = join(fixtureDir, 'small.mp4');
  largeVideo = join(fixtureDir, 'large.mp4');
  audioOnly = join(fixtureDir, 'audio-only.m4a');
  rotatedVideo = join(fixtureDir, 'rotated.mp4');
  noDurationVideo = join(fixtureDir, 'no-duration.mkv');
  soundVideo = join(fixtureDir, 'sound.mp4');
  const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x36:rate=10', ...encode, smallVideo,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x36:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    ...encode, '-c:a', 'aac', '-shortest', soundVideo,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=1920x1080:rate=10', ...encode, largeVideo,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioOnly,
  ]);

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

const expectProbeCode = async (
  promise: Promise<unknown>,
  code: MediaProbeErrorCode,
): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    expect(isMediaProbeError(error)).toBe(true);
    if (isMediaProbeError(error)) {
      expect(error.code).toBe(code);
    }
    return;
  }
  throw new Error(`expected a rejection with code ${code}`);
};

describe('FfmpegSourceError', () => {
  it('is identified by the isFfmpegSourceError guard', () => {
    const error = new FfmpegSourceError('NO_VIDEO_STREAM', 'song.mp3: no video stream');
    expect(isFfmpegSourceError(error)).toBe(true);
    expect(error.code).toBe('NO_VIDEO_STREAM');
    expect(error.message).toBe('song.mp3: no video stream');
    expect(error.name).toBe('FfmpegSourceError');
  });

  it('rejects plain errors and non-errors', () => {
    expect(isFfmpegSourceError(new Error('NO_VIDEO_STREAM'))).toBe(false);
    expect(isFfmpegSourceError('NO_VIDEO_STREAM')).toBe(false);
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

/** Polls until the condition holds or five seconds pass */
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

  it('surfaces hasAudio on the source info', async () => {
    const source = createFfmpegSource({ filePath: soundVideo });
    const info = await source.open();
    expect(info.hasAudio).toBe(true);
    await source.close();
  });

  it('rejects open() for a missing file with FILE_NOT_FOUND', async () => {
    const source = createFfmpegSource({ filePath: join(fixtureDir, 'missing.mp4') });
    await expectProbeCode(source.open(), 'FILE_NOT_FOUND');
  });

  it('rejects open() for an audio-only file with NO_VIDEO_STREAM', async () => {
    const source = createFfmpegSource({ filePath: audioOnly });
    await expectCode(source.open(), 'NO_VIDEO_STREAM');
  });

  it('skips its own probe when a pre-computed probe is given', async () => {
    const source = createFfmpegSource({
      filePath: smallVideo,
      probe: {
        kind: 'video',
        nativeWidth: 64,
        nativeHeight: 36,
        durationMs: 2_000,
        fps: 10,
        hasAudio: false,
      },
    });
    const info = await source.open();
    expect(info.width).toBe(64);
    expect(info.durationMs).toBe(2_000);
    const frame = await waitForFrame(source, 0);
    expect(frame.length).toBe(64 * 36 * RGB_CHANNELS);
    await source.close();
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

  it('spawns no decoder when close lands during open', async () => {
    // A large frame size blocks ffmpeg on its stdout pipe (15 MB of
    // frames), so a leaked decoder would still be alive and findable in
    // the process table. The fixture copy has a path no other test's
    // ffmpeg ever carries, so a neighbor's just-killed process cannot
    // alias the pgrep match.
    const leakProbeVideo = join(fixtureDir, 'leak-probe.mp4');
    await copyFile(largeVideo, leakProbeVideo);
    const source = createFfmpegSource({ filePath: leakProbeVideo });
    const opening = source.open();
    await source.close();
    await opening;
    await expect(source.getFrameAt(0)).resolves.toBeNull();
    let leakedDecoder = true;
    try {
      await execFileAsync('pgrep', ['-f', leakProbeVideo]);
    } catch {
      // pgrep exits nonzero when nothing matches
      leakedDecoder = false;
    }
    expect(leakedDecoder).toBe(false);
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

  it('fills the readahead after open and stops reporting buffering', async () => {
    const source = createFfmpegSource({ filePath: smallVideo });
    await source.open();
    await waitForCondition(() => !(source.isBuffering?.() ?? false));
    // The filled readahead serves without further waiting
    await expect(source.getFrameAt(0)).resolves.not.toBeNull();
    await source.close();
    expect(source.isBuffering?.()).toBe(false);
  });

  it('stops reporting buffering when the stream ends before the readahead fills', async () => {
    const source = createFfmpegSource({ filePath: smallVideo });
    await source.open();
    // 1900 ms into the 2 s fixture leaves a single frame, far below the
    // readahead cap, so only the decoder's exit ends the buffering
    await source.seek(1_900);
    await waitForCondition(() => !(source.isBuffering?.() ?? false));
    const frame = await waitForFrame(source, 1_900);
    expect(frame.length).toBe(64 * 36 * RGB_CHANNELS);
    await source.close();
  });
});

describe('http(s) URL sources', () => {
  const HTTP_OK = 200;
  const HTTP_PARTIAL_CONTENT = 206;
  const HTTP_NOT_FOUND = 404;

  // Serves the fixture files over a real local HTTP server with byte-range
  // support, which ffmpeg's http reader uses to seek. Fixtures are tiny, so
  // each request just reads the whole file and slices.
  let fixtureServer: Server;
  let fixtureBaseUrl: string;

  beforeAll(async () => {
    fixtureServer = createServer((request, response) => {
      void (async () => {
        let data: Buffer;
        try {
          data = await readFile(join(fixtureDir, basename(request.url ?? '')));
        } catch {
          response.writeHead(HTTP_NOT_FOUND);
          response.end();
          return;
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
        if (range === null) {
          response.writeHead(HTTP_OK, {
            'Accept-Ranges': 'bytes',
            'Content-Length': data.length,
          });
          response.end(data);
          return;
        }
        const start = Number(range[1]);
        const end = range[2] === '' ? data.length - 1 : Math.min(Number(range[2]), data.length - 1);
        response.writeHead(HTTP_PARTIAL_CONTENT, {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': end - start + 1,
        });
        response.end(data.subarray(start, end + 1));
      })();
    });
    await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    const address = fixtureServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fixture server reported no port');
    }
    fixtureBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    // SIGKILLed decoders can leave sockets open, so drop them before close
    fixtureServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      fixtureServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it('serves frames from a URL', async () => {
    const source = createFfmpegSource({ filePath: `${fixtureBaseUrl}/${basename(smallVideo)}` });
    const info = await source.open();
    const frame = await waitForFrame(source, 0);
    expect(frame.length).toBe(info.width * info.height * RGB_CHANNELS);
    await source.close();
  });

  it('seeks a URL to the same frame sequential playback reaches', async () => {
    const source = createFfmpegSource({ filePath: `${fixtureBaseUrl}/${basename(smallVideo)}` });
    await source.open();
    const sequential = await waitForFrame(source, 1_500);
    await source.seek(1_500);
    const sought = await waitForFrame(source, 1_500);
    expect(sought).toEqual(sequential);
    await source.close();
  });
});

describe('non-seekable http sources', () => {
  const HTTP_OK = 200;
  const HTTP_NOT_FOUND = 404;

  // Ignores Range and streams the body chunked with no Content-Length, the
  // shape a generate-on-the-fly server produces. ffmpeg cannot seek this,
  // so the decoders must read from the start instead of passing input-side
  // -ss (which corrupts live-muxed matroska decoding on such a stream).
  let streamServer: Server;
  let streamBaseUrl: string;

  beforeAll(async () => {
    streamServer = createServer((request, response) => {
      void (async () => {
        let data: Buffer;
        try {
          data = await readFile(join(fixtureDir, basename(request.url ?? '')));
        } catch {
          response.writeHead(HTTP_NOT_FOUND);
          response.end();
          return;
        }
        // write() before end() forces chunked encoding with no
        // Content-Length, matching a generate-on-the-fly server
        response.writeHead(HTTP_OK);
        response.write(data);
        response.end();
      })();
    });
    await new Promise<void>((resolve) => streamServer.listen(0, '127.0.0.1', resolve));
    const address = streamServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('stream server reported no port');
    }
    streamBaseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    streamServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      streamServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  // The live-muxed matroska fixture mirrors what such servers actually
  // serve (mp4 fixtures need a seekable input for their trailing moov)
  it('plays a stream from a server without range support', async () => {
    const source = createFfmpegSource({
      filePath: `${streamBaseUrl}/${basename(noDurationVideo)}`,
    });
    const info = await source.open();
    const frame = await waitForFrame(source, 0);
    expect(frame.length).toBe(info.width * info.height * RGB_CHANNELS);
    await source.close();
  });

  it('seeks a non-seekable stream by reading from the start', async () => {
    const source = createFfmpegSource({
      filePath: `${streamBaseUrl}/${basename(noDurationVideo)}`,
    });
    await source.open();
    const sequential = await waitForFrame(source, 500);
    await source.seek(500);
    const sought = await waitForFrame(source, 500);
    expect(sought).toEqual(sequential);
    await source.close();
  });
});
