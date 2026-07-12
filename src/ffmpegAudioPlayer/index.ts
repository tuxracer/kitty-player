import { spawn } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';

import type { AudioPlayer, AudioPlayerInfo } from '../audioPlayer/index.ts';
import {
  AUDIO_QUEUE_CAP_MS,
  AUDIO_UNAVAILABLE_MESSAGE,
  BYTES_PER_SAMPLE,
  CHANNELS,
  DEVICE_FRAME_SIZE,
  MS_PER_SECOND,
  SAMPLE_RATE,
  STDERR_TAIL_MAX_CHARS,
  VOLUME_FULL,
  VOLUME_MUTED,
} from './consts.ts';
import { probeHasAudio } from './probe.ts';
import { createRtAudioDevice } from './rtAudioDevice.ts';
import type { AudioDecoder, AudioDevice, FfmpegAudioPlayerOptions } from './types.ts';

export * from './consts.ts';
export * from './types.ts';
export { probeHasAudio } from './probe.ts';
export { createRtAudioDevice } from './rtAudioDevice.ts';

/**
 * Creates an AudioPlayer decoding a file's audio track with the bundled
 * ffmpeg into an audify (RtAudio) output stream. One ffmpeg process per
 * playFrom decodes s16le PCM from an input-side -ss offset, mirroring the
 * video decoder's respawn-on-seek pattern. pause kills the decoder and
 * clears the device queue, so resume is always a fresh playFrom at the
 * playhead and sync is exact after every transition. Audio problems never
 * reject: open resolves hasAudio false (with a one-time notice when a
 * device exists to complain about) and the player plays silent video.
 */
export const createFfmpegAudioPlayer = (options: FfmpegAudioPlayerOptions): AudioPlayer => {
  const { filePath, createDevice = createRtAudioDevice } = options;

  let device: AudioDevice | null = null;
  let decoder: AudioDecoder | null = null;
  let closed = false;
  let muted = false;
  let decodeFailureNoted = false;

  // Read through a function around the createDevice await below: TypeScript's
  // control-flow narrowing does not model the concurrent close() call that
  // can land during that await, so it otherwise infers the direct variable
  // read as permanently false and eslint flags the recheck as dead code.
  const isClosed = (): boolean => closed;

  // Feed accounting. framesWritten minus framesPlayed is the queued backlog,
  // which drives ffmpeg stdout backpressure. framesPlayed drives the audible
  // position. Both reset on every playFrom and pause.
  let framesWritten = 0;
  let framesPlayed = 0;

  const frameBytes = (activeDevice: AudioDevice): number =>
    activeDevice.frameSize * CHANNELS * BYTES_PER_SAMPLE;

  const frameDurationMs = (activeDevice: AudioDevice): number =>
    (activeDevice.frameSize / SAMPLE_RATE) * MS_PER_SECOND;

  const queueCapFrames = (activeDevice: AudioDevice): number =>
    Math.ceil(AUDIO_QUEUE_CAP_MS / frameDurationMs(activeDevice));

  const onFrameDone = (): void => {
    framesPlayed += 1;
    if (
      device !== null &&
      decoder !== null &&
      !decoder.killed &&
      framesWritten - framesPlayed < queueCapFrames(device)
    ) {
      decoder.child.stdout.resume();
    }
  };

  const killDecoder = (): void => {
    if (decoder !== null) {
      decoder.killed = true;
      decoder.child.kill('SIGKILL');
      decoder = null;
    }
  };

  const spawnDecoder = (startMs: number, activeDevice: AudioDevice): AudioDecoder => {
    // open() checked ffmpegPath before creating the device, and playFrom
    // only runs with a device, so this cannot trigger. It satisfies the
    // narrowing without a cast.
    if (ffmpegPath === null) {
      throw new Error('unreachable: ffmpeg path was checked in open()');
    }
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', `${startMs / MS_PER_SECOND}`,
        '-i', filePath,
        '-vn',
        '-sn',
        '-f', 's16le',
        '-ar', `${SAMPLE_RATE}`,
        '-ac', `${CHANNELS}`,
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const current: AudioDecoder = { startMs, killed: false, ended: false, child };
    const bytes = frameBytes(activeDevice);

    // Chunks accumulate until at least one whole device frame arrived, then
    // a single concat slices out every complete frame, the same batching the
    // video decoder uses. A trailing partial frame at end of stream (under
    // one frame, about 21 ms) is dropped.
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    let stderrTail = '';

    child.stdout.on('data', (chunk: Buffer) => {
      if (current.killed) {
        return;
      }
      pendingChunks.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes < bytes) {
        return;
      }
      const merged = pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks);
      let offset = 0;
      while (merged.length - offset >= bytes) {
        // audify copies the PCM into its native queue synchronously, so
        // handing it a subarray view is safe
        activeDevice.write(merged.subarray(offset, offset + bytes));
        framesWritten += 1;
        offset += bytes;
      }
      pendingChunks = offset < merged.length ? [merged.subarray(offset)] : [];
      pendingBytes = merged.length - offset;
      if (framesWritten - framesPlayed >= queueCapFrames(activeDevice)) {
        child.stdout.pause();
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_CHARS);
    });

    const noteFailure = (): void => {
      if (current.killed || closed || decodeFailureNoted) {
        return;
      }
      decodeFailureNoted = true;
      const detail = stderrTail.trim();
      process.stderr.write(
        `kitty-video-player: audio decode failed${detail === '' ? '' : `: ${detail}`}\n`,
      );
    };

    child.on('error', noteFailure);
    child.on('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        noteFailure();
      } else if (!current.killed) {
        current.ended = true;
      }
    });

    return current;
  };

  const open = async (): Promise<AudioPlayerInfo> => {
    if (device !== null) {
      // open() is call-once: a repeat call reports the existing state
      // instead of opening (and leaking) a second device
      return { hasAudio: true };
    }
    const hasStream = await probeHasAudio(filePath);
    if (!hasStream || ffmpegPath === null || closed) {
      return { hasAudio: false };
    }
    const openedDevice = await createDevice({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: DEVICE_FRAME_SIZE,
      onFrameDone,
    });
    if (isClosed()) {
      openedDevice?.close();
      return { hasAudio: false };
    }
    device = openedDevice;
    if (device === null) {
      process.stderr.write(`${AUDIO_UNAVAILABLE_MESSAGE}\n`);
      return { hasAudio: false };
    }
    device.setVolume(muted ? VOLUME_MUTED : VOLUME_FULL);
    return { hasAudio: true };
  };

  const playFrom = (timeMs: number): void => {
    if (closed || device === null) {
      return;
    }
    killDecoder();
    device.clearQueue();
    framesWritten = 0;
    framesPlayed = 0;
    decoder = spawnDecoder(timeMs, device);
  };

  const pause = (): void => {
    if (closed || device === null) {
      return;
    }
    killDecoder();
    device.clearQueue();
    framesWritten = 0;
    framesPlayed = 0;
  };

  const setMuted = (nextMuted: boolean): void => {
    muted = nextMuted;
    if (!closed && device !== null) {
      device.setVolume(muted ? VOLUME_MUTED : VOLUME_FULL);
    }
  };

  const getPositionMs = (): number | null => {
    if (closed || device === null || decoder === null) {
      return null;
    }
    if (decoder.ended && framesPlayed >= framesWritten) {
      return null;
    }
    return decoder.startMs + framesPlayed * frameDurationMs(device);
  };

  const close = (): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    closed = true;
    killDecoder();
    device?.close();
    device = null;
    return Promise.resolve();
  };

  return { open, playFrom, pause, setMuted, getPositionMs, close };
};
