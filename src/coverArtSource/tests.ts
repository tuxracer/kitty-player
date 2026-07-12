import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import ffmpegPath from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isFfmpegSourceError } from '../ffmpegSource/index.ts';
import { COVER_ART_FPS, RGB_CHANNELS, createCoverArtSource } from './index.ts';

const execFileAsync = promisify(execFile);

let fixtureDir: string;
let artMp3: string;
let plainMp3: string;

const ART_WIDTH = 64;
const ART_HEIGHT = 36;
const DURATION_MS = 2_000;
const FIXTURE_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  if (ffmpegPath === null) {
    throw new Error('ffmpeg-static provides no binary for this platform');
  }
  fixtureDir = await mkdtemp(join(tmpdir(), 'kitty-media-player-cover-art-'));
  plainMp3 = join(fixtureDir, 'plain.mp3');
  artMp3 = join(fixtureDir, 'art.mp3');
  const coverPng = join(fixtureDir, 'cover.png');
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', plainMp3,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', `color=c=red:size=${ART_WIDTH}x${ART_HEIGHT}`, '-frames:v', '1', coverPng,
  ]);
  await execFileAsync(ffmpegPath, [
    '-i', plainMp3, '-i', coverPng, '-map', '0:a', '-map', '1:v', '-c', 'copy',
    '-id3v2_version', '3', '-disposition:v:0', 'attached_pic', artMp3,
  ]);
}, FIXTURE_TIMEOUT_MS);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

const artOptions = () => ({
  filePath: artMp3,
  durationMs: DURATION_MS,
  nativeWidth: ART_WIDTH,
  nativeHeight: ART_HEIGHT,
});

describe('createCoverArtSource', () => {
  it('opens with the art dimensions, rgb24, the audio duration, and the nominal fps', async () => {
    const source = createCoverArtSource(artOptions());
    const info = await source.open();
    expect(info.width).toBe(ART_WIDTH);
    expect(info.height).toBe(ART_HEIGHT);
    expect(info.colorSpace).toBe('rgb24');
    expect(info.durationMs).toBe(DURATION_MS);
    expect(info.fps).toBe(COVER_ART_FPS);
    expect(info.hasAudio).toBe(true);
    await source.close();
  });

  it('serves the decoded picture, matching the art pixels', async () => {
    const source = createCoverArtSource(artOptions());
    await source.open();
    const frame = await source.getFrameAt(0);
    expect(frame).not.toBeNull();
    if (frame !== null) {
      expect(frame.length).toBe(ART_WIDTH * ART_HEIGHT * RGB_CHANNELS);
      // The cover is solid red. Compression can shift values slightly.
      const RED_MIN = 200;
      const OTHER_MAX = 80;
      expect(frame[0]).toBeGreaterThanOrEqual(RED_MIN);
      expect(frame[1]).toBeLessThanOrEqual(OTHER_MAX);
      expect(frame[2]).toBeLessThanOrEqual(OTHER_MAX);
    }
    await source.close();
  });

  it('keeps serving the frame on repeated calls and after seeks (the gate retries there)', async () => {
    const source = createCoverArtSource(artOptions());
    await source.open();
    await expect(source.getFrameAt(0)).resolves.not.toBeNull();
    await expect(source.getFrameAt(100)).resolves.not.toBeNull();
    await source.seek(1_000);
    await expect(source.getFrameAt(1_000)).resolves.not.toBeNull();
    await source.close();
  });

  it('rejects open() with DECODE_FAILED for a file without extractable art', async () => {
    const source = createCoverArtSource({
      filePath: plainMp3,
      durationMs: DURATION_MS,
      nativeWidth: ART_WIDTH,
      nativeHeight: ART_HEIGHT,
    });
    try {
      await source.open();
    } catch (error) {
      expect(isFfmpegSourceError(error)).toBe(true);
      if (isFfmpegSourceError(error)) {
        expect(error.code).toBe('DECODE_FAILED');
      }
      return;
    }
    throw new Error('expected open() to reject');
  });

  it('resolves null after close, and close is idempotent', async () => {
    const source = createCoverArtSource(artOptions());
    await source.open();
    await source.close();
    await expect(source.getFrameAt(0)).resolves.toBeNull();
    await expect(source.close()).resolves.toBeUndefined();
  });
});
