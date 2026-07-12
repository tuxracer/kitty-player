import type { ManagedAudioResources } from './types.ts';

export const AUDIO_TICK_MS = 50;
export const DRIFT_RESYNC_THRESHOLD_MS = 250;
export const LOADING_DELAY_MS = 1_000;
export const MS_PER_SECOND = 1_000;
export const PERCENT_MAX = 100;
export const PROGRESS_BAR_WIDTH = 32;
export const MIN_PROGRESS_BAR_WIDTH = 1;
export const SEEK_STEP_MS = 5_000;
export const PLAY_GLYPH = '▶';
export const PAUSE_GLYPH = '⏸';
export const LOADING_TEXT = 'loading audio…';
export const BUFFERING_TEXT = 'buffering…';

export const INITIAL_MANAGED_AUDIO_RESOURCES: ManagedAudioResources = {
  status: 'loading',
  audio: null,
  durationMs: null,
};
