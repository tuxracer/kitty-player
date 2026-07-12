import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import ffmpegPath from 'ffmpeg-static';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUDIO_PREBUFFER_MS,
  AUDIO_QUEUE_CAP_MS,
  AUDIO_UNAVAILABLE_MESSAGE,
  BYTES_PER_SAMPLE,
  CHANNELS,
  RTAUDIO_FORMAT_SINT16,
  SAMPLE_RATE,
  VOLUME_MUTED,
} from './consts.ts';
import { createFfmpegAudioPlayer } from './index.ts';
import { probeHasAudio } from './probe.ts';
import { createRtAudioDevice } from './rtAudioDevice.ts';
import type { AudioDevice, AudioDeviceOptions, CreateAudioDevice } from './types.ts';

// The fake audify module mirrors the real one's CJS default-export interop
// shape. It is hoisted so vi.mock can reference it.
const audifyMock = vi.hoisted(() => {
  const state = {
    constructorThrows: false,
    hideOutputVolume: false,
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
      if (state.hideOutputVolume) {
        // Shadow the prototype accessor so the instance looks like a build
        // without the volume property
        Object.defineProperty(this, 'outputVolume', { value: undefined, configurable: true });
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
    audifyMock.state.hideOutputVolume = false;
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
    // Never register audify's native frameOutputCallback: it creates a
    // thread-safe function that audify never releases, so the process can
    // never exit again once a stream was opened with one
    expect(args[7]).toBeNull();
    device?.close();
  });

  it('paces onFrameDone from the clock, clamped to frames written', async () => {
    vi.useFakeTimers();
    try {
      // Pin the frame size the stream actually opens with (the pacing must
      // follow it, not the requested size)
      audifyMock.state.openStreamReturn = 1_024;
      let frameDone = 0;
      const device = await createRtAudioDevice({
        ...deviceOptions(),
        onFrameDone: () => {
          frameDone += 1;
        },
      });
      // 1_024 samples at 48 kHz is about 21.3 ms per frame
      device?.write(Buffer.alloc(16));
      device?.write(Buffer.alloc(16));
      device?.write(Buffer.alloc(16));
      // Nothing has had time to play yet
      expect(frameDone).toBe(0);
      // Two frame durations later (next pacing tick at 50 ms), two frames finished
      await vi.advanceTimersByTimeAsync(50);
      expect(frameDone).toBe(2);
      // The clock keeps running but only three frames were ever written
      await vi.advanceTimersByTimeAsync(500);
      expect(frameDone).toBe(3);
      // New writes resume the pacing
      device?.write(Buffer.alloc(16));
      await vi.advanceTimersByTimeAsync(50);
      expect(frameDone).toBe(4);
      device?.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearQueue resets the pacing so dropped frames never report as played', async () => {
    vi.useFakeTimers();
    try {
      audifyMock.state.openStreamReturn = 1_024;
      let frameDone = 0;
      const device = await createRtAudioDevice({
        ...deviceOptions(),
        onFrameDone: () => {
          frameDone += 1;
        },
      });
      device?.write(Buffer.alloc(16));
      device?.write(Buffer.alloc(16));
      device?.clearQueue();
      // The cleared frames were dropped from the device queue, they must
      // not finish playing
      await vi.advanceTimersByTimeAsync(500);
      expect(frameDone).toBe(0);
      device?.write(Buffer.alloc(16));
      await vi.advanceTimersByTimeAsync(50);
      expect(frameDone).toBe(1);
      device?.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close stops the pacing timer', async () => {
    vi.useFakeTimers();
    try {
      let frameDone = 0;
      const device = await createRtAudioDevice({
        ...deviceOptions(),
        onFrameDone: () => {
          frameDone += 1;
        },
      });
      device?.write(Buffer.alloc(16));
      device?.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(frameDone).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports the frame size the stream actually opened with', async () => {
    audifyMock.state.openStreamReturn = 480;
    const device = await createRtAudioDevice(deviceOptions());
    expect(device?.frameSize).toBe(480);
    device?.close();
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

  it('resolves null when the instance lacks a numeric outputVolume', async () => {
    // A build without the volume property would make setVolume (so mute) a
    // silent no-op, better to degrade to no audio at all
    audifyMock.state.hideOutputVolume = true;
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
let shortAudio: string;
let liveAudio: string;
let longAudio: string;

const FIXTURE_TIMEOUT_MS = 60_000;

beforeAll(async () => {
  if (ffmpegPath === null) {
    throw new Error('ffmpeg-static provides no binary for this platform');
  }
  fixtureDir = await mkdtemp(join(tmpdir(), 'kitty-video-player-audio-'));
  withAudio = join(fixtureDir, 'with-audio.mp4');
  silentVideo = join(fixtureDir, 'silent.mp4');
  notMedia = join(fixtureDir, 'not-media.txt');
  shortAudio = join(fixtureDir, 'short-audio.mp4');
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
  // Video runs 2s, audio only 1s, without -shortest so the container keeps
  // going until the video stream finishes. Exercises the decoder's clean
  // end-of-stream exit while the video clock is still running.
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x36:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    ...encode, '-c:a', 'aac', shortAudio,
  ]);
  // Live-mode matroska (no duration header, streamable front to back) for
  // the non-seekable http test, matching what streaming servers serve
  liveAudio = join(fixtureDir, 'live-audio.mka');
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', 'aac', '-f', 'matroska', '-live', '1', liveAudio,
  ]);
  // Longer than the queue cap, so the backpressure test can actually hit it
  longAudio = join(fixtureDir, 'long-audio.m4a');
  await execFileAsync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'aac', longAudio,
  ]);
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

interface FakeDeviceHarness {
  written: Buffer[];
  clearQueueCalls: number;
  volumes: number[];
  closeCalls: number;
  createCalls: number;
  /** Simulates the device playing count queued frames (fires onFrameDone) */
  playFrames: (count: number) => void;
  createDevice: CreateAudioDevice;
}

const FAKE_FRAME_SIZE = 1_024;

const createFakeDeviceFactory = (available = true): FakeDeviceHarness => {
  let onFrameDone: () => void = () => undefined;
  const harness: FakeDeviceHarness = {
    written: [],
    clearQueueCalls: 0,
    volumes: [],
    closeCalls: 0,
    createCalls: 0,
    playFrames: (count) => {
      for (let i = 0; i < count; i++) {
        onFrameDone();
      }
    },
    createDevice: (options) => {
      harness.createCalls += 1;
      if (!available) {
        return Promise.resolve(null);
      }
      onFrameDone = options.onFrameDone;
      const device: AudioDevice = {
        frameSize: FAKE_FRAME_SIZE,
        write: (pcm) => {
          harness.written.push(Buffer.from(pcm));
        },
        clearQueue: () => {
          harness.clearQueueCalls += 1;
        },
        setVolume: (volume) => {
          harness.volumes.push(volume);
        },
        close: () => {
          harness.closeCalls += 1;
        },
      };
      return Promise.resolve(device);
    },
  };
  return harness;
};

describe('createFfmpegAudioPlayer open and close', () => {
  it('opens with hasAudio for a file with an audio stream', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await expect(player.open()).resolves.toEqual({ hasAudio: true });
    expect(fake.createCalls).toBe(1);
    await player.close();
  });

  it('opens silent for a file without an audio stream and never touches the device', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: silentVideo, createDevice: fake.createDevice });
    await expect(player.open()).resolves.toEqual({ hasAudio: false });
    expect(fake.createCalls).toBe(0);
    await player.close();
  });

  it('degrades to silent with one stderr notice when no device is available', async () => {
    const fake = createFakeDeviceFactory(false);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
      await expect(player.open()).resolves.toEqual({ hasAudio: false });
      const notices = stderrSpy.mock.calls.filter(([text]) =>
        String(text).includes(AUDIO_UNAVAILABLE_MESSAGE),
      );
      expect(notices).toHaveLength(1);
      // Every later call is a no-op, not a crash
      player.playFrom(0);
      player.pause();
      player.setMuted(true);
      expect(player.getPositionMs()).toBeNull();
      await player.close();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('uses an injected probeAudio instead of running its own ffprobe', async () => {
    const fake = createFakeDeviceFactory();
    // silentVideo has no audio stream, so a real probe would refuse: the
    // injected result must win
    const player = createFfmpegAudioPlayer({
      filePath: silentVideo,
      createDevice: fake.createDevice,
      probeAudio: () => Promise.resolve(true),
    });
    await expect(player.open()).resolves.toEqual({ hasAudio: true });
    expect(fake.createCalls).toBe(1);
    await player.close();
  });

  it('opens silent when the injected probeAudio rejects', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({
      filePath: withAudio,
      createDevice: fake.createDevice,
      probeAudio: () => Promise.reject(new Error('shared video probe failed')),
    });
    await expect(player.open()).resolves.toEqual({ hasAudio: false });
    expect(fake.createCalls).toBe(0);
    await player.close();
  });

  it('a second open reuses the device instead of opening another', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await expect(player.open()).resolves.toEqual({ hasAudio: true });
    await expect(player.open()).resolves.toEqual({ hasAudio: true });
    expect(fake.createCalls).toBe(1);
    await player.close();
    expect(fake.closeCalls).toBe(1);
  });

  it('close is idempotent and closes the device', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    await player.close();
    await player.close();
    expect(fake.closeCalls).toBe(1);
  });

  it('closes a device that finishes opening after close', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    const opening = player.open();
    await player.close();
    await expect(opening).resolves.toEqual({ hasAudio: false });
    // Every created device gets closed, whether close() lands during the
    // ffprobe await or during the createDevice await.
    expect(fake.closeCalls).toBe(fake.createCalls);
  });
});

/** Polls until the condition holds or five seconds pass */
const waitFor = async (condition: () => boolean): Promise<void> => {
  const deadlineMs = Date.now() + 5_000;
  while (Date.now() < deadlineMs) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met within 5s');
};

describe('createFfmpegAudioPlayer playback', () => {
  it('feeds the device exact device-frame chunks after playFrom', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    player.playFrom(0);
    await waitFor(() => fake.written.length >= 3);
    const expectedBytes = FAKE_FRAME_SIZE * CHANNELS * BYTES_PER_SAMPLE;
    for (const chunk of fake.written) {
      expect(chunk.length).toBe(expectedBytes);
    }
    await player.close();
  });

  it('stops feeding at the queue cap until the device plays frames', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: longAudio, createDevice: fake.createDevice });
    await player.open();
    player.playFrom(0);
    // The 12 s fixture holds far more than the cap, so an uncapped feed
    // would blow well past it. One pipe read can overshoot the cap by a
    // few frames, hence the slack.
    const capFrames = Math.ceil(
      (AUDIO_QUEUE_CAP_MS / 1_000) * (SAMPLE_RATE / FAKE_FRAME_SIZE),
    );
    await waitFor(() => fake.written.length >= capFrames);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const writtenAtCap = fake.written.length;
    expect(writtenAtCap).toBeLessThan(capFrames + 50);
    fake.playFrames(capFrames);
    await waitFor(() => fake.written.length > writtenAtCap);
    await player.close();
  });

  it('holds sound back until a comfortable prebuffer exists, then flushes it at once', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    player.playFrom(0);
    await waitFor(() => fake.written.length > 0);
    // Nothing reaches the device until the whole prebuffer arrives in one
    // flush, so the first observation is already the full lead
    const frameMs = (FAKE_FRAME_SIZE / SAMPLE_RATE) * 1_000;
    expect(fake.written.length).toBeGreaterThanOrEqual(Math.floor(AUDIO_PREBUFFER_MS / frameMs));
    await player.close();
  });

  it('flushes a partial prebuffer when the track ends before the target', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    // 1500 ms into the 2 s track leaves less audio than the prebuffer target
    player.playFrom(1_500);
    await waitFor(() => fake.written.length > 0);
    const frameMs = (FAKE_FRAME_SIZE / SAMPLE_RATE) * 1_000;
    expect(fake.written.length * frameMs).toBeLessThan(AUDIO_PREBUFFER_MS);
    // The finished attempt releases the clock's gate instead of stalling it
    await waitFor(() => !player.isStarting());
    await player.close();
  });

  it('tracks position as the playFrom offset plus frames actually played', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    expect(player.getPositionMs()).toBeNull();
    player.playFrom(500);
    // No sound has played yet, so there is no audible position. Reporting
    // the frozen start offset here is what made the clock's drift snap
    // kill slow-starting (remote) decoders every second.
    expect(player.getPositionMs()).toBeNull();
    await waitFor(() => fake.written.length >= 10);
    fake.playFrames(10);
    const frameMs = (FAKE_FRAME_SIZE / SAMPLE_RATE) * 1_000;
    expect(player.getPositionMs()).toBeCloseTo(500 + 10 * frameMs, 5);
    await player.close();
  });

  it('pause clears the device queue and nulls the position', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    player.playFrom(0);
    await waitFor(() => fake.written.length >= 1);
    player.pause();
    // playFrom cleared once (fresh start), pause cleared again
    expect(fake.clearQueueCalls).toBe(2);
    expect(player.getPositionMs()).toBeNull();
    await player.close();
  });

  it('plays a non-seekable http stream, with playFrom reading from the start', async () => {
    const HTTP_OK = 200;
    // Ignores Range and streams chunked with no Content-Length, so the
    // decoder must place -ss output-side instead of asking the demuxer to
    // seek a stream that cannot
    const server = createServer((_request, response) => {
      void (async () => {
        const data = await readFile(liveAudio);
        response.writeHead(HTTP_OK);
        response.write(data);
        response.end();
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('stream server reported no port');
    }
    const url = `http://127.0.0.1:${address.port}/live-audio.mka`;
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: url, createDevice: fake.createDevice });
    try {
      await expect(player.open()).resolves.toEqual({ hasAudio: true });
      player.playFrom(500);
      await waitFor(() => fake.written.length >= 3);
      fake.playFrames(1);
      const frameMs = (FAKE_FRAME_SIZE / SAMPLE_RATE) * 1_000;
      expect(player.getPositionMs()).toBeCloseTo(500 + frameMs, 5);
    } finally {
      await player.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it('reports isStarting only between playFrom and the first played frame', async () => {
    const fake = createFakeDeviceFactory();
    // The long fixture keeps the decoder alive (paused at the queue cap)
    // through the mid-flight assertion; a track shorter than the cap
    // decodes fully and exits, which correctly ends the starting state
    const player = createFfmpegAudioPlayer({ filePath: longAudio, createDevice: fake.createDevice });
    await player.open();
    expect(player.isStarting()).toBe(false);
    player.playFrom(0);
    expect(player.isStarting()).toBe(true);
    await waitFor(() => fake.written.length >= 1);
    // PCM is queued but nothing has played yet
    expect(player.isStarting()).toBe(true);
    fake.playFrames(1);
    expect(player.isStarting()).toBe(false);
    player.pause();
    expect(player.isStarting()).toBe(false);
    await player.close();
  });

  it('stops counting as starting when the decoder exits without sound', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    // Far past the 2 s track: ffmpeg exits cleanly with no output. The dead
    // attempt must release the clock's buffering gate instead of stalling
    // it, so it stops counting as starting.
    player.playFrom(60_000);
    await waitFor(() => !player.isStarting());
    expect(fake.written.length).toBe(0);
    await player.close();
  });

  it('playFrom while playing restarts cleanly from the new offset', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    player.playFrom(0);
    await waitFor(() => fake.written.length >= 1);
    player.playFrom(1_000);
    // Both playFrom calls clear the queue for a fresh start
    expect(fake.clearQueueCalls).toBe(2);
    const writtenBefore = fake.written.length;
    await waitFor(() => fake.written.length > writtenBefore);
    fake.playFrames(1);
    const frameMs = (FAKE_FRAME_SIZE / SAMPLE_RATE) * 1_000;
    expect(player.getPositionMs()).toBeCloseTo(1_000 + frameMs, 5);
    await player.close();
  });

  it('mute and unmute flip the device volume without stopping the feed', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    player.playFrom(0);
    player.setMuted(true);
    player.setMuted(false);
    // open() applied full volume once, then the two toggles
    expect(fake.volumes).toEqual([1, 0, 1]);
    // The feed keeps running through the toggles
    await waitFor(() => fake.written.length >= 1);
    await player.close();
  });

  it('opening muted applies zero volume at open', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    player.setMuted(true);
    await player.open();
    expect(fake.volumes).toEqual([0]);
    await player.close();
  });

  it('parks the position at null after the audio track ends and drains', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: shortAudio, createDevice: fake.createDevice });
    await player.open();
    player.playFrom(0);

    // Some frames arrive and queue up (the queue cap holds off the rest)
    // before anything has played, so a backlog exists. Once sound has
    // started playing, position must report normally, whether or not the
    // decoder has already exited.
    await waitFor(() => fake.written.length >= 10);
    fake.playFrames(1);
    expect(player.getPositionMs()).not.toBeNull();

    // Drain everything the decoder has queued or will queue, repeatedly,
    // until writes stop arriving. The audio track is only ~1s (about 47
    // frames at 1024 samples), and the fake device applies no realtime
    // pacing, so this settles fast.
    let played = 0;
    let lastWritten = -1;
    let stableSince = Date.now();
    const deadlineMs = Date.now() + 5_000;
    while (Date.now() - stableSince < 300) {
      if (Date.now() > deadlineMs) {
        throw new Error('writes never stabilized within 5s');
      }
      if (fake.written.length !== lastWritten) {
        lastWritten = fake.written.length;
        stableSince = Date.now();
      }
      if (fake.written.length > played) {
        const toPlay = fake.written.length - played;
        fake.playFrames(toPlay);
        played += toPlay;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Drain anything left queued so framesPlayed catches up to framesWritten.
    const remaining = fake.written.length - played;
    if (remaining > 0) {
      fake.playFrames(remaining);
      played += remaining;
    }

    // The decoder's 'close' event lands asynchronously, so ended flips some
    // time after the last data event.
    await waitFor(() => player.getPositionMs() === null);
    await player.close();
  });

  it('notes a decoder death once on stderr', async () => {
    const fake = createFakeDeviceFactory();
    const player = createFfmpegAudioPlayer({ filePath: withAudio, createDevice: fake.createDevice });
    await player.open();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      player.playFrom(0);
      // Killing the decoder on purpose (the respawn below) must NOT note a
      // failure. Deleting the file makes the respawned ffmpeg exit nonzero
      // immediately, which must note exactly once.
      await rm(withAudio);
      player.playFrom(0);
      await waitFor(() =>
        stderrSpy.mock.calls.some(([text]) => String(text).includes('audio decode failed')),
      );
      const notices = stderrSpy.mock.calls.filter(([text]) =>
        String(text).includes('audio decode failed'),
      );
      expect(notices).toHaveLength(1);
    } finally {
      stderrSpy.mockRestore();
      await player.close();
      // Regenerate the fixture for any tests that still need it
      if (ffmpegPath !== null) {
        const encode = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];
        await execFileAsync(ffmpegPath, [
          '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x36:rate=10',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
          ...encode, '-c:a', 'aac', '-shortest', withAudio,
        ]);
      }
    }
  });
});
