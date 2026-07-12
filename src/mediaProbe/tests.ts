import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import ffmpegPath from 'ffmpeg-static';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MediaProbeError, isMediaProbeError, probeMediaFile } from './index.ts';
import type {
  AudioProbeResult,
  MediaProbeErrorCode,
  MediaProbeResult,
  VideoProbeResult,
} from './index.ts';

const execFileAsync = promisify(execFile);

// Real fixture files generated once per run with the bundled ffmpeg, so the
// suite exercises the actual ffprobe classification with no mocks.
let fixtureDir: string;
let smallVideo: string;
let soundVideo: string;
let rotatedVideo: string;
let noDurationVideo: string;
let toneMp3: string;
let toneOgg: string;
let artMp3: string;
let noDurationAudio: string;
let subsOnly: string;
let notMedia: string;

const FIXTURE_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  if (ffmpegPath === null) {
    throw new Error('ffmpeg-static provides no binary for this platform');
  }
  fixtureDir = await mkdtemp(join(tmpdir(), 'kitty-media-player-media-probe-'));
  smallVideo = join(fixtureDir, 'small.mp4');
  soundVideo = join(fixtureDir, 'sound.mp4');
  rotatedVideo = join(fixtureDir, 'rotated.mp4');
  noDurationVideo = join(fixtureDir, 'no-duration.mkv');
  toneMp3 = join(fixtureDir, 'tone.mp3');
  toneOgg = join(fixtureDir, 'tone.ogg');
  artMp3 = join(fixtureDir, 'art.mp3');
  noDurationAudio = join(fixtureDir, 'no-duration-audio.mka');
  subsOnly = join(fixtureDir, 'subs-only.mkv');
  notMedia = join(fixtureDir, 'not-media.txt');

  const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x36:rate=10', ...encode, smallVideo,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x36:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    ...encode, '-c:a', 'aac', '-shortest', soundVideo,
  ]);
  const rotatedSource = join(fixtureDir, 'rotated-source.mp4');
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x36:rate=10', ...encode, rotatedSource,
  ]);
  await execFileAsync(ffmpegPath, [
    '-display_rotation', '90', '-i', rotatedSource, '-c', 'copy', rotatedVideo,
  ]);
  // Live-mode matroska writes no duration header (same shape for video and audio)
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x36:rate=10', ...encode,
    '-f', 'matroska', '-live', '1', noDurationVideo,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', toneMp3,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', toneOgg,
  ]);
  const coverPng = join(fixtureDir, 'cover.png');
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'color=c=red:size=64x36', '-frames:v', '1', coverPng,
  ]);
  // An mp3 whose only "video" stream is the embedded cover art
  await execFileAsync(ffmpegPath, [
    '-i', toneMp3, '-i', coverPng, '-map', '0:a', '-map', '1:v', '-c', 'copy',
    '-id3v2_version', '3', '-disposition:v:0', 'attached_pic', artMp3,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le',
    '-f', 'matroska', '-live', '1', noDurationAudio,
  ]);
  const subsSrt = join(fixtureDir, 'subs.srt');
  await writeFile(subsSrt, '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  await execFileAsync(ffmpegPath, ['-i', subsSrt, '-c:s', 'srt', subsOnly]);
  await writeFile(notMedia, 'this is not a media file\n');
}, FIXTURE_TIMEOUT_MS);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

const asVideo = (probe: MediaProbeResult): VideoProbeResult => {
  if (probe.kind !== 'video') {
    throw new Error(`expected a video classification, got ${probe.kind}`);
  }
  return probe;
};

const asAudio = (probe: MediaProbeResult): AudioProbeResult => {
  if (probe.kind !== 'audio') {
    throw new Error(`expected an audio classification, got ${probe.kind}`);
  }
  return probe;
};

const expectCode = async (
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

describe('MediaProbeError', () => {
  it('is identified by the isMediaProbeError guard', () => {
    const error = new MediaProbeError('FILE_NOT_FOUND', 'missing.mp4: no such file');
    expect(isMediaProbeError(error)).toBe(true);
    expect(error.code).toBe('FILE_NOT_FOUND');
    expect(error.name).toBe('MediaProbeError');
  });

  it('rejects plain errors and non-errors', () => {
    expect(isMediaProbeError(new Error('FILE_NOT_FOUND'))).toBe(false);
    expect(isMediaProbeError(null)).toBe(false);
  });
});

describe('probeMediaFile on video files', () => {
  it('classifies a video file with dimensions, duration, and fps', async () => {
    const probe = asVideo(await probeMediaFile(smallVideo));
    expect(probe.nativeWidth).toBe(64);
    expect(probe.nativeHeight).toBe(36);
    expect(probe.fps).toBe(10);
    expect(probe.durationMs).toBeGreaterThanOrEqual(1_900);
    expect(probe.durationMs).toBeLessThanOrEqual(2_100);
  });

  it('reports hasAudio for a file with an audio track and not for a silent one', async () => {
    expect(asVideo(await probeMediaFile(soundVideo)).hasAudio).toBe(true);
    expect(asVideo(await probeMediaFile(smallVideo)).hasAudio).toBe(false);
  });

  it('swaps dimensions for quarter-turned rotation metadata', async () => {
    const probe = asVideo(await probeMediaFile(rotatedVideo));
    expect(probe.nativeWidth).toBe(36);
    expect(probe.nativeHeight).toBe(64);
  });

  it('measures duration when the container header lacks one', async () => {
    const probe = asVideo(await probeMediaFile(noDurationVideo));
    expect(probe.durationMs).toBeGreaterThanOrEqual(900);
    expect(probe.durationMs).toBeLessThanOrEqual(1_100);
  });
});

describe('probeMediaFile on audio files', () => {
  it('classifies an mp3 as audio with its duration and no cover art', async () => {
    const probe = asAudio(await probeMediaFile(toneMp3));
    expect(probe.durationMs).toBeGreaterThanOrEqual(1_900);
    expect(probe.durationMs).toBeLessThanOrEqual(2_200);
    expect(probe.coverArt).toBeNull();
  });

  it('classifies an ogg as audio', async () => {
    const probe = asAudio(await probeMediaFile(toneOgg));
    expect(probe.durationMs).toBeGreaterThanOrEqual(1_900);
  });

  it('classifies an mp3 with embedded cover art as audio, not video', async () => {
    const probe = asAudio(await probeMediaFile(artMp3));
    expect(probe.coverArt).toEqual({ nativeWidth: 64, nativeHeight: 36 });
  });

  it('measures audio duration when the container header lacks one', async () => {
    const probe = asAudio(await probeMediaFile(noDurationAudio));
    expect(probe.durationMs).toBeGreaterThanOrEqual(900);
    expect(probe.durationMs).toBeLessThanOrEqual(1_100);
  });
});

describe('probeMediaFile failures', () => {
  it('rejects a missing path with FILE_NOT_FOUND', async () => {
    await expectCode(probeMediaFile(join(fixtureDir, 'missing.mp4')), 'FILE_NOT_FOUND');
  });

  it('rejects a non-media file with PROBE_FAILED', async () => {
    await expectCode(probeMediaFile(notMedia), 'PROBE_FAILED');
  });

  it('rejects a subtitles-only file with NO_PLAYABLE_STREAMS', async () => {
    await expectCode(probeMediaFile(subsOnly), 'NO_PLAYABLE_STREAMS');
  });
});

describe('probeMediaFile on http(s) URLs', () => {
  let fixtureServer: Server;
  let fixtureBaseUrl: string;

  beforeAll(async () => {
    // mp3 is fully streamable, so a plain no-range static server is enough
    fixtureServer = createServer((request, response) => {
      void (async () => {
        try {
          const data = await readFile(join(fixtureDir, basename(request.url ?? '')));
          response.writeHead(200, { 'Content-Length': data.length });
          response.end(data);
        } catch {
          response.writeHead(404);
          response.end();
        }
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
    fixtureServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      fixtureServer.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it('classifies an mp3 URL as audio without requiring a local file', async () => {
    const probe = asAudio(await probeMediaFile(`${fixtureBaseUrl}/${basename(toneMp3)}`));
    expect(probe.durationMs).toBeGreaterThanOrEqual(1_900);
  });

  it('rejects an unreachable URL with PROBE_FAILED, not FILE_NOT_FOUND', async () => {
    await expectCode(probeMediaFile('http://127.0.0.1:1/missing.mp3'), 'PROBE_FAILED');
  });
});
