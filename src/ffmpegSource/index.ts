import { spawn } from 'node:child_process';

import ffmpegPath from 'ffmpeg-static';

import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';
import {
  MS_PER_SECOND,
  READAHEAD_FRAME_CAP,
  RGB_CHANNELS,
  STDERR_TAIL_MAX_CHARS,
} from './consts.ts';
import { FfmpegSourceError } from './errors.ts';
import { computeDecodeSize, probeFile } from './probe.ts';
import type { Decoder, FfmpegSourceOptions } from './types.ts';

export * from './consts.ts';
export * from './errors.ts';
export * from './probe.ts';
export * from './types.ts';

/**
 * Creates a FrameSource decoding a video file with the bundled ffmpeg.
 * One long-lived ffmpeg process streams rawvideo rgb24 frames (scaled to fit
 * the MAX_DECODE_* caps) into a readahead queue. Seeks and backward time
 * jumps (the player's loop-around at end of file) respawn the process with
 * input-side -ss. open() rejects with FfmpegSourceError; a mid-playback
 * decoder death is noted once on stderr and getFrameAt resolves null from
 * then on (the player keeps showing the last frame).
 */
export const createFfmpegSource = (options: FfmpegSourceOptions): FrameSource => {
  const { filePath } = options;

  let info: FrameSourceInfo | null = null;
  let decoder: Decoder | null = null;
  let closed = false;
  let decodeFailureNoted = false;

  const queueCapacity = (fps: number): number =>
    Math.min(Math.ceil(fps), READAHEAD_FRAME_CAP);

  const spawnDecoder = (startMs: number, streamInfo: FrameSourceInfo): Decoder => {
    if (ffmpegPath === null) {
      throw new FfmpegSourceError(
        'DECODE_FAILED',
        'ffmpeg-static provides no binary for this platform',
      );
    }
    const frameBytes = streamInfo.width * streamInfo.height * RGB_CHANNELS;
    const frameIntervalMs = MS_PER_SECOND / streamInfo.fps;
    const child = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-ss', `${startMs / MS_PER_SECOND}`,
        '-i', filePath,
        '-vf', `scale=${streamInfo.width}:${streamInfo.height}`,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-an',
        '-sn',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const current: Decoder = { frames: [], nextTimestampMs: startMs, killed: false, child };

    // Chunks accumulate until at least one whole frame arrived, then a single
    // concat slices out every complete frame (one copy per data event, not
    // one per chunk).
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    let stderrTail = '';

    child.stdout.on('data', (chunk: Buffer) => {
      pendingChunks.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes < frameBytes) {
        return;
      }
      const merged = pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks);
      let offset = 0;
      while (merged.length - offset >= frameBytes) {
        current.frames.push({
          timestampMs: current.nextTimestampMs,
          data: merged.subarray(offset, offset + frameBytes),
        });
        current.nextTimestampMs += frameIntervalMs;
        offset += frameBytes;
      }
      pendingChunks = offset < merged.length ? [merged.subarray(offset)] : [];
      pendingBytes = merged.length - offset;
      if (current.frames.length >= queueCapacity(streamInfo.fps)) {
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
        `kitty-video-player: video decode failed${detail === '' ? '' : `: ${detail}`}\n`,
      );
    };

    child.on('error', noteFailure);
    child.on('close', (code, signal) => {
      if (code !== 0 || signal !== null) {
        noteFailure();
      }
    });

    return current;
  };

  const killDecoder = (): void => {
    if (decoder !== null) {
      decoder.killed = true;
      decoder.child.kill('SIGKILL');
      decoder = null;
    }
  };

  const open = async (): Promise<FrameSourceInfo> => {
    const probe = await probeFile(filePath);
    const { width, height } = computeDecodeSize(probe.nativeWidth, probe.nativeHeight);
    info = {
      width,
      height,
      colorSpace: 'rgb24',
      durationMs: probe.durationMs,
      fps: probe.fps,
    };
    decoder = spawnDecoder(0, info);
    return info;
  };

  const getFrameAt = (timeMs: number): Promise<Uint8Array | null> => {
    if (closed || info === null || decoder === null) {
      return Promise.resolve(null);
    }
    const toleranceMs = MS_PER_SECOND / info.fps / 2;

    // A jump to before anything still available (the player's loop-around at
    // end of file, or any rewind) restarts the decode at the requested time.
    // This same path doubles as recovery after a mid-playback decoder death:
    // the next loop-around respawns the decoder on the file.
    const earliestMs = decoder.frames[0]?.timestampMs ?? decoder.nextTimestampMs;
    if (timeMs < earliestMs - toleranceMs) {
      killDecoder();
      decoder = spawnDecoder(timeMs, info);
      return Promise.resolve(null);
    }

    // Drop frames playback has passed, then serve the head. The head frame
    // stays queued so repeat requests at the same time (paused repaints)
    // return the same frame.
    while (decoder.frames.length > 0 && decoder.frames[0].timestampMs < timeMs - toleranceMs) {
      decoder.frames.shift();
    }
    if (decoder.frames.length < queueCapacity(info.fps)) {
      decoder.child.stdout.resume();
    }
    const frame = decoder.frames.at(0);
    return Promise.resolve(frame === undefined ? null : frame.data);
  };

  const seek = (timeMs: number): Promise<void> => {
    if (closed || info === null) {
      return Promise.resolve();
    }
    killDecoder();
    decoder = spawnDecoder(timeMs, info);
    return Promise.resolve();
  };

  const close = (): Promise<void> => {
    closed = true;
    killDecoder();
    return Promise.resolve();
  };

  return { open, getFrameAt, seek, close };
};
