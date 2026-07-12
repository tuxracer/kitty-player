/**
 * kitty-video-player library entry. Re-exports the public surface for hosts that
 * embed the Video component in their own Ink app instead of running the CLI. The cli
 * module is deliberately not exported (it is the executable bin entry and
 * runs the player on import).
 *
 * Exports are explicit rather than star exports because several modules
 * define their own MS_PER_SECOND. Star-exporting them all would make that
 * name ambiguous and silently drop it, so per-module duplicates like
 * MS_PER_SECOND stay internal.
 */
export { Video, canDisplayVideo, createManagedScreen } from './Video/index.tsx';
export type {
  ExternalVideoProps,
  ManagedResources,
  ManagedResourcesOptions,
  ManagedScreenOptions,
  ManagedStatus,
  ManagedVideoProps,
  PlaybackCallbacks,
  PlaybackClock,
  PlaybackClockOptions,
  PlayerScreen,
  VideoBaseProps,
  VideoErrorCode,
  VideoLoadedMetadataEvent,
  VideoProps,
  VideoRef,
  VideoTimeUpdateEvent,
} from './Video/index.tsx';
export { VideoError, isVideoError } from './Video/index.tsx';
export {
  DRIFT_RESYNC_THRESHOLD_MS,
  HELP_TEXT,
  LOADING_DELAY_MS,
  LOADING_TEXT,
  PAUSE_GLYPH,
  PERCENT_MAX,
  PLAY_GLYPH,
  PLAYER_TITLE,
  PROGRESS_BAR_WIDTH,
  RESIZE_DEBOUNCE_MS,
  SEEK_STEP_MS,
} from './Video/index.tsx';

export type { FrameSource, FrameSourceInfo } from './frameSource/index.ts';

export type { AudioPlayer, AudioPlayerInfo } from './audioPlayer/index.ts';

export { createFfmpegAudioPlayer, createRtAudioDevice, probeHasAudio } from './ffmpegAudioPlayer/index.ts';
export type {
  AudioDevice,
  AudioDeviceOptions,
  CreateAudioDevice,
  FfmpegAudioPlayerOptions,
} from './ffmpegAudioPlayer/index.ts';
export {
  AUDIO_QUEUE_CAP_MS,
  CHANNELS,
  DEVICE_FRAME_SIZE,
  SAMPLE_RATE,
} from './ffmpegAudioPlayer/index.ts';

export { createProceduralSource } from './proceduralSource/index.ts';
export type { ProceduralSourceOptions } from './proceduralSource/index.ts';

export { computeEmbeddedRegion, computePanelRegion } from './playerLayout/index.ts';
export type { EmbeddedRegionOptions, PanelRegionOptions } from './playerLayout/index.ts';
export {
  CELL_ASPECT_RATIO,
  CHROME_ROWS,
  MAX_PANEL_COLS,
  MIN_AVAILABLE_CELLS,
  PANEL_HORIZONTAL_MARGIN,
} from './playerLayout/index.ts';

export { formatTime } from './formatTime/index.ts';

export { FfmpegSourceError, createFfmpegSource, isFfmpegSourceError } from './ffmpegSource/index.ts';
export type { DecodeSize, FfmpegSourceErrorCode, FfmpegSourceOptions } from './ffmpegSource/index.ts';
export { MAX_DECODE_HEIGHT, MAX_DECODE_WIDTH, computeDecodeSize } from './ffmpegSource/index.ts';
