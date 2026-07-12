import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';

import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

import { isRecord } from '../isRecord/index.ts';
import { isRemoteUrl } from '../isRemoteUrl/index.ts';
import {
  HALF_ROTATION_DEGREES,
  MICROSECONDS_PER_MS,
  MS_PER_SECOND,
  QUARTER_ROTATION_DEGREES,
} from './consts.ts';
import { MediaProbeError } from './errors.ts';
import type { CoverArtInfo, MediaProbeResult } from './types.ts';

export * from './consts.ts';
export * from './errors.ts';
export * from './types.ts';

const execFileAsync = promisify(execFile);

/** ffprobe reports numbers both as JSON numbers and as decimal strings */
const asFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
};

/** r_frame_rate arrives as a fraction string like "30000/1001" */
const parseFrameRate = (value: unknown): number | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const [numerator, denominator = '1'] = value.split('/');
  const num = asFiniteNumber(numerator);
  const den = asFiniteNumber(denominator);
  if (num === null || den === null || num <= 0 || den <= 0) {
    return null;
  }
  return num / den;
};

/**
 * Display rotation in degrees from the stream's display matrix side data,
 * 0 when absent. ffmpeg autorotates decoded frames, so a quarter-turned
 * stream emits swapped dimensions.
 */
const readRotation = (stream: Record<string, unknown>): number => {
  if (!Array.isArray(stream.side_data_list)) {
    return 0;
  }
  for (const entry of stream.side_data_list) {
    if (isRecord(entry)) {
      const rotation = asFiniteNumber(entry.rotation);
      if (rotation !== null) {
        return rotation;
      }
    }
  }
  return 0;
};

/** True for a stream that is embedded cover art, not playable video */
const isAttachedPic = (stream: Record<string, unknown>): boolean =>
  isRecord(stream.disposition) && asFiniteNumber(stream.disposition.attached_pic) === 1;

/**
 * Demuxes one stream to null at stream-copy speed and reports the last
 * progress timestamp. Recovers the duration of live-muxed files whose
 * container header carries none. Reads the whole file without decoding,
 * so it runs at thousands of times realtime. Resolves null when the
 * duration still cannot be determined.
 */
const measureDurationMs = async (
  filePath: string,
  streamSpecifier: string,
): Promise<number | null> => {
  if (ffmpegPath === null) {
    return null;
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-v', 'error',
      '-progress', 'pipe:1',
      '-i', filePath,
      '-map', streamSpecifier,
      '-c', 'copy',
      '-f', 'null',
      '-',
    ]));
  } catch {
    return null;
  }
  let lastMicroseconds: number | null = null;
  for (const match of stdout.matchAll(/^out_time_us=(\d+)$/gm)) {
    lastMicroseconds = Number(match[1]);
  }
  if (lastMicroseconds === null || lastMicroseconds <= 0) {
    return null;
  }
  return Math.round(lastMicroseconds / MICROSECONDS_PER_MS);
};

/** Header duration in ms from the stream or the container format, measured as a fallback */
const resolveDurationMs = async (
  filePath: string,
  stream: Record<string, unknown>,
  format: unknown,
  streamSpecifier: string,
): Promise<number | null> => {
  const headerSeconds =
    asFiniteNumber(stream.duration) ??
    (isRecord(format) ? asFiniteNumber(format.duration) : null);
  if (headerSeconds !== null && headerSeconds > 0) {
    return Math.round(headerSeconds * MS_PER_SECOND);
  }
  return measureDurationMs(filePath, streamSpecifier);
};

/**
 * Classifies a media file (local path or http(s) URL) with one ffprobe run.
 * A file with a real video stream is 'video' (embedded cover art marked
 * attached_pic does not count). A file with only audio is 'audio', carrying
 * its cover art dimensions when an attached picture exists. Rejects with
 * MediaProbeError: FILE_NOT_FOUND, PROBE_FAILED (unreadable media or
 * missing metadata), or NO_PLAYABLE_STREAMS (neither video nor audio).
 */
export const probeMediaFile = async (filePath: string): Promise<MediaProbeResult> => {
  if (!isRemoteUrl(filePath)) {
    try {
      await access(filePath);
    } catch {
      throw new MediaProbeError('FILE_NOT_FOUND', `${filePath}: no such file`);
    }
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(ffprobeStatic.path, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ]));
  } catch (error) {
    const detail = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    throw new MediaProbeError(
      'PROBE_FAILED',
      `${filePath}: not a readable media file${detail === '' ? '' : ` (${detail})`}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new MediaProbeError('PROBE_FAILED', `${filePath}: ffprobe emitted unparseable JSON`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.streams)) {
    throw new MediaProbeError('PROBE_FAILED', `${filePath}: ffprobe reported no streams`);
  }
  const streams = parsed.streams.filter(isRecord);

  const video = streams.find(
    (stream) => stream.codec_type === 'video' && !isAttachedPic(stream),
  );
  if (video !== undefined) {
    const nativeWidth = asFiniteNumber(video.width);
    const nativeHeight = asFiniteNumber(video.height);
    const fps = parseFrameRate(video.r_frame_rate);
    if (
      nativeWidth === null || nativeWidth <= 0 ||
      nativeHeight === null || nativeHeight <= 0 ||
      fps === null
    ) {
      throw new MediaProbeError(
        'PROBE_FAILED',
        `${filePath}: video stream is missing dimensions or frame rate`,
      );
    }
    const durationMs = await resolveDurationMs(filePath, video, parsed.format, '0:v:0');
    if (durationMs === null || durationMs <= 0) {
      throw new MediaProbeError(
        'PROBE_FAILED',
        `${filePath}: could not determine the video duration`,
      );
    }
    const hasAudio = streams.some((stream) => stream.codec_type === 'audio');
    const quarterTurned =
      Math.abs(readRotation(video)) % HALF_ROTATION_DEGREES === QUARTER_ROTATION_DEGREES;
    return {
      kind: 'video',
      nativeWidth: quarterTurned ? nativeHeight : nativeWidth,
      nativeHeight: quarterTurned ? nativeWidth : nativeHeight,
      durationMs,
      fps,
      hasAudio,
    };
  }

  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (audio === undefined) {
    throw new MediaProbeError(
      'NO_PLAYABLE_STREAMS',
      `${filePath}: no video or audio stream to play`,
    );
  }
  const durationMs = await resolveDurationMs(filePath, audio, parsed.format, '0:a:0');
  if (durationMs === null || durationMs <= 0) {
    throw new MediaProbeError(
      'PROBE_FAILED',
      `${filePath}: could not determine the audio duration`,
    );
  }

  const attachedPic = streams.find(
    (stream) => stream.codec_type === 'video' && isAttachedPic(stream),
  );
  let coverArt: CoverArtInfo | null = null;
  if (attachedPic !== undefined) {
    const artWidth = asFiniteNumber(attachedPic.width);
    const artHeight = asFiniteNumber(attachedPic.height);
    if (artWidth !== null && artWidth > 0 && artHeight !== null && artHeight > 0) {
      coverArt = { nativeWidth: artWidth, nativeHeight: artHeight };
    }
  }
  return { kind: 'audio', durationMs, coverArt };
};
