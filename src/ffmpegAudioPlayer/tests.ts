import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import ffmpegPath from 'ffmpeg-static';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RTAUDIO_FORMAT_SINT16,
  SAMPLE_RATE,
  VOLUME_MUTED,
} from './consts.ts';
import { createRtAudioDevice } from './rtAudioDevice.ts';
import type { AudioDeviceOptions } from './types.ts';
import { probeHasAudio } from './probe.ts';

// The fake audify module mirrors the real one's CJS default-export interop
// shape. It is hoisted so vi.mock can reference it.
const audifyMock = vi.hoisted(() => {
  const state = {
    constructorThrows: false,
    openStreamArgs: [] as unknown[][],
    written: [] as Buffer[],
    clearQueueCalls: 0,
    startCalls: 0,
    stopCalls: 0,
    closeStreamCalls: 0,
    volume: 1,
    openStreamReturn: 512,
  };
  class FakeRtAudio {
    constructor() {
      if (state.constructorThrows) {
        throw new Error('no audio backend');
      }
    }
    get outputVolume(): number {
      return state.volume;
    }
    set outputVolume(value: number) {
      state.volume = value;
    }
    openStream(...args: unknown[]): number {
      state.openStreamArgs.push(args);
      return state.openStreamReturn;
    }
    getDefaultOutputDevice(): number {
      return 7;
    }
    start(): void {
      state.startCalls += 1;
    }
    stop(): void {
      state.stopCalls += 1;
    }
    closeStream(): void {
      state.closeStreamCalls += 1;
    }
    write(pcm: Buffer): void {
      state.written.push(pcm);
    }
    clearOutputQueue(): void {
      state.clearQueueCalls += 1;
    }
  }
  return { state, FakeRtAudio };
});

vi.mock('audify', () => ({ default: { RtAudio: audifyMock.FakeRtAudio } }));

const deviceOptions = (): AudioDeviceOptions => ({
  sampleRate: SAMPLE_RATE,
  channels: 2,
  frameSize: 1_024,
  onFrameDone: () => undefined,
});

describe('createRtAudioDevice', () => {
  beforeEach(() => {
    audifyMock.state.constructorThrows = false;
    audifyMock.state.openStreamArgs = [];
    audifyMock.state.written = [];
    audifyMock.state.clearQueueCalls = 0;
    audifyMock.state.startCalls = 0;
    audifyMock.state.stopCalls = 0;
    audifyMock.state.closeStreamCalls = 0;
    audifyMock.state.volume = 1;
    audifyMock.state.openStreamReturn = 512;
  });

  it('opens an s16 output stream at the requested rate and starts it', async () => {
    const device = await createRtAudioDevice(deviceOptions());
    expect(device).not.toBeNull();
    expect(audifyMock.state.startCalls).toBe(1);
    const args = audifyMock.state.openStreamArgs[0];
    expect(args[0]).toEqual({ deviceId: 7, nChannels: 2 });
    expect(args[1]).toBeNull();
    expect(args[2]).toBe(RTAUDIO_FORMAT_SINT16);
    expect(args[3]).toBe(SAMPLE_RATE);
    expect(args[4]).toBe(1_024);
  });

  it('reports the frame size the stream actually opened with', async () => {
    audifyMock.state.openStreamReturn = 480;
    const device = await createRtAudioDevice(deviceOptions());
    expect(device?.frameSize).toBe(480);
  });

  it('delegates write, clearQueue, setVolume, and close to the stream', async () => {
    const device = await createRtAudioDevice(deviceOptions());
    const pcm = Buffer.alloc(16);
    device?.write(pcm);
    expect(audifyMock.state.written).toEqual([pcm]);
    device?.clearQueue();
    expect(audifyMock.state.clearQueueCalls).toBe(1);
    device?.setVolume(VOLUME_MUTED);
    expect(audifyMock.state.volume).toBe(VOLUME_MUTED);
    device?.close();
    expect(audifyMock.state.stopCalls).toBe(1);
    expect(audifyMock.state.closeStreamCalls).toBe(1);
  });

  it('resolves null when the RtAudio constructor throws', async () => {
    audifyMock.state.constructorThrows = true;
    await expect(createRtAudioDevice(deviceOptions())).resolves.toBeNull();
  });
});

const execFileAsync = promisify(execFile);

// Real fixture files generated once per run with the bundled ffmpeg, so the
// suite exercises the actual probe/decode pipeline with no mocks.
let fixtureDir: string;
let withAudio: string;
let silentVideo: string;
let notMedia: string;

const FIXTURE_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  if (ffmpegPath === null) {
    throw new Error('ffmpeg-static provides no binary for this platform');
  }
  fixtureDir = await mkdtemp(join(tmpdir(), 'kitty-video-player-audio-'));
  withAudio = join(fixtureDir, 'with-audio.mp4');
  silentVideo = join(fixtureDir, 'silent.mp4');
  notMedia = join(fixtureDir, 'not-media.txt');
  const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x36:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    ...encode, '-c:a', 'aac', '-shortest', withAudio,
  ]);
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x36:rate=10', ...encode, silentVideo,
  ]);
  await writeFile(notMedia, 'this is not a media file\n');
}, FIXTURE_TIMEOUT_MS);

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

describe('probeHasAudio', () => {
  it('finds the audio stream in a video with sound', async () => {
    await expect(probeHasAudio(withAudio)).resolves.toBe(true);
  });

  it('reports false for a silent video', async () => {
    await expect(probeHasAudio(silentVideo)).resolves.toBe(false);
  });

  it('reports false for a missing file instead of throwing', async () => {
    await expect(probeHasAudio(join(fixtureDir, 'missing.mp4'))).resolves.toBe(false);
  });

  it('reports false for a non-media file instead of throwing', async () => {
    await expect(probeHasAudio(notMedia)).resolves.toBe(false);
  });
});
