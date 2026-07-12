import { spawn } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';

import type { AudioPlayer, AudioPlayerInfo } from '../audioPlayer/index.ts';
import { detectRangeSupport } from '../detectRangeSupport/index.ts';
import { isRemoteUrl } from '../isRemoteUrl/index.ts';
import {
  AUDIO_PREBUFFER_MS,
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
 * playFrom decodes s16le PCM from an -ss offset (placed by the video
 * decoder's seekability rules), mirroring the respawn-on-seek pattern.
 * pause kills the decoder and clears the device queue, so resume is always
 * a fresh playFrom at the playhead and sync is exact after every
 * transition. Audio problems never reject: open resolves hasAudio false
 * (with a one-time notice when a device exists to complain about) and the
 * player plays silent video.
 *
 * A decoder takes time to produce its first sound (near zero for local
 * files, seconds for remote streams). The clock waits it out: every audio
 * start goes through the clock's buffering gate, which holds playback
 * while isStarting reports a live decode attempt with no sound out yet
 * and releases when sound plays or the attempt dies. Until then
 * getPositionMs reports null, so the drift snap leaves a starting decoder
 * alone instead of killing it every second (which silenced remote
 * playback entirely). Each start also holds AUDIO_PREBUFFER_MS of PCM
 * back from the device before releasing any of it, so the sound begins
 * with a cushion that absorbs delivery hiccups instead of underrunning at
 * the first one.
 */
export const createFfmpegAudioPlayer = (options: FfmpegAudioPlayerOptions): AudioPlayer => {
  const {
    filePath,
    createDevice = createRtAudioDevice,
    probeAudio = () => probeHasAudio(filePath),
  } = options;

  let device: AudioDevice | null = null;
  let decoder: AudioDecoder | null = null;
  let closed = false;
  let muted = false;
  let decodeFailureNoted = false;
  // Whether ffmpeg can seek the input (local files, range-supporting
  // servers). Decides where -ss goes when the decoder spawns, set by open()
  let inputSeekable = true;

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
    // -ss placement mirrors the video decoder: nothing at zero (a seek to 0
    // corrupts live-muxed matroska over non-seekable http), input-side on
    // seekable inputs, output-side (read from the start, discard decoded
    // output up to the target) on streams that cannot seek.
    const startArgs = startMs > 0 ? ['-ss', `${startMs / MS_PER_SECOND}`] : [];
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        ...(inputSeekable ? startArgs : []),
        '-i', filePath,
        '-vn',
        '-sn',
        ...(inputSeekable ? [] : startArgs),
        '-f', 's16le',
        '-ar', `${SAMPLE_RATE}`,
        '-ac', `${CHANNELS}`,
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const current: AudioDecoder = { startMs, killed: false, ended: false, exited: false, child };
    const bytes = frameBytes(activeDevice);

    // Prebuffer: frames are held back from the device until a comfortable
    // lead exists, so the sound starts with AUDIO_PREBUFFER_MS of cushion
    // behind it instead of running hand-to-mouth. The device plays what it
    // is given immediately, which is why the holdback happens here and not
    // in its queue. A track that ends (or a decoder that dies) before the
    // target flushes whatever arrived.
    const prebufferFrames = Math.ceil(AUDIO_PREBUFFER_MS / frameDurationMs(activeDevice));
    let heldFrames: Buffer[] = [];
    let primed = false;

    const flushHeldFrames = (): void => {
      primed = true;
      for (const pcm of heldFrames) {
        activeDevice.write(pcm);
      }
      heldFrames = [];
    };

    const deliverFrame = (pcm: Buffer): void => {
      framesWritten += 1;
      if (primed) {
        activeDevice.write(pcm);
        return;
      }
      heldFrames.push(pcm);
      if (heldFrames.length >= prebufferFrames) {
        flushHeldFrames();
      }
    };

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
        // audify copies the PCM into its native queue synchronously, and
        // held frames keep their merged buffer alive, so subarray views
        // are safe in both paths
        deliverFrame(merged.subarray(offset, offset + bytes));
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

    child.on('error', () => {
      current.exited = true;
      noteFailure();
    });
    child.on('close', (code, signal) => {
      current.exited = true;
      if (!current.killed) {
        // The stream is over before the prebuffer target was reached (a
        // short track, a seek near the end, or a dead decoder): play out
        // whatever arrived instead of holding it forever
        flushHeldFrames();
      }
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
    let hasStream = false;
    try {
      // The range probe (never rejects) rides along with the audio probe
      [hasStream, inputSeekable] = await Promise.all([
        probeAudio(),
        isRemoteUrl(filePath) ? detectRangeSupport(filePath) : true,
      ]);
    } catch {
      // An injected probe may reject (a failed shared video probe), which
      // means silent playback, never a crash
    }
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

  const isStarting = (): boolean =>
    // A live decode attempt that has produced no sound yet. Once the
    // process exits (clean end past the track, crash) it can never
    // produce sound, so it stops counting as starting even with nothing
    // played, which releases the clock's buffering gate instead of
    // stalling it on an audio attempt that is already dead.
    !closed && decoder !== null && !decoder.exited && framesPlayed === 0;

  const getPositionMs = (): number | null => {
    if (closed || device === null || decoder === null) {
      return null;
    }
    // No sound has come out of this decoder yet (still spinning up after
    // playFrom): there is no audible position, and reporting the frozen
    // start offset would make the clock's drift snap kill a decoder that
    // just needs time to deliver
    if (framesPlayed === 0) {
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

  return { open, playFrom, pause, setMuted, isStarting, getPositionMs, close };
};
