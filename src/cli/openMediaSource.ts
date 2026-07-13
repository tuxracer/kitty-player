import { createFfmpegSource } from '../ffmpegSource/index.ts';
import type { OpenMediaSourceOptions, OpenedMediaSource } from './types.ts';

/**
 * Builds and opens the video FrameSource, reusing the existing classification.
 * Audio-only visual selection lives in openAudioVisual.
 */
export const openMediaSource = async (
  options: OpenMediaSourceOptions,
): Promise<OpenedMediaSource> => {
  const {
    filePath,
    probe,
    createVideoSource = createFfmpegSource,
  } = options;
  if (probe.kind !== 'video') {
    throw new TypeError('openMediaSource requires a video probe');
  }
  const source = createVideoSource({ filePath, probe });
  return { source, info: await source.open() };
};
