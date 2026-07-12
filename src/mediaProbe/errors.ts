import type { MediaProbeErrorCode } from './types.ts';

/** Typed failure from classifying a media file */
export class MediaProbeError extends Error {
  readonly code: MediaProbeErrorCode;

  constructor(code: MediaProbeErrorCode, message: string) {
    super(message);
    this.name = 'MediaProbeError';
    this.code = code;
  }
}

export const isMediaProbeError = (error: unknown): error is MediaProbeError =>
  error instanceof MediaProbeError;
