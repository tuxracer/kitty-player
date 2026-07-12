/** Machine-readable reasons a media probe can fail */
export type MediaProbeErrorCode = 'FILE_NOT_FOUND' | 'PROBE_FAILED' | 'NO_PLAYABLE_STREAMS';

/** Native pixel size of an embedded cover art picture */
export interface CoverArtInfo {
  /** Native pixel width of the attached picture */
  nativeWidth: number;
  /** Native pixel height of the attached picture */
  nativeHeight: number;
}

/** Classification of a file with a real (non cover art) video stream */
export interface VideoProbeResult {
  kind: 'video';
  /** Native pixel width of the video stream */
  nativeWidth: number;
  /** Native pixel height of the video stream */
  nativeHeight: number;
  /** Total duration in ms */
  durationMs: number;
  /** Native frame rate */
  fps: number;
  /** True when the container also carries an audio stream */
  hasAudio: boolean;
}

/** Classification of an audio-only file (its cover art does not count as video) */
export interface AudioProbeResult {
  kind: 'audio';
  /** Total duration in ms */
  durationMs: number;
  /** The embedded cover art picture, or null when the file has none */
  coverArt: CoverArtInfo | null;
}

/** What kind of media a file holds, from one ffprobe run */
export type MediaProbeResult = VideoProbeResult | AudioProbeResult;
