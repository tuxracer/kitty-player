import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import ffprobeStatic from 'ffprobe-static';

import { isRecord } from '../isRecord/index.ts';

const execFileAsync = promisify(execFile);

/**
 * True when ffprobe finds at least one audio stream in the file. Every
 * failure (missing file, unreadable media, ffprobe crash) reports false,
 * because audio problems never fail the player. The video pipeline owns
 * error reporting for broken files.
 */
export const probeHasAudio = async (filePath: string): Promise<boolean> => {
  try {
    const { stdout } = await execFileAsync(ffprobeStatic.path, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-print_format', 'json',
      filePath,
    ]);
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) && Array.isArray(parsed.streams) && parsed.streams.length > 0;
  } catch {
    return false;
  }
};
