/** How far one left/right arrow press moves the playhead, in ms */
export const SEEK_STEP_MS = 5_000;

/** Quiet period after the last terminal resize event before the panel relays out */
export const RESIZE_DEBOUNCE_MS = 150;

/** Milliseconds per second, for tick-interval math and whole-second display updates */
export const MS_PER_SECOND = 1_000;

/** ProgressBar value scale (its value prop runs 0 to 100) */
export const PERCENT_MAX = 100;

/** Fixed progress bar width in terminal columns */
export const PROGRESS_BAR_WIDTH = 32;

/** Title line above the video panel */
export const PLAYER_TITLE = ' kitty-video-player';

/** Glyph shown in the controls row while playing */
export const PLAY_GLYPH = '▶';

/** Glyph shown in the controls row while paused */
export const PAUSE_GLYPH = '⏸';

/** Help line under the controls */
export const HELP_TEXT = 'space play/pause · ←/→ seek 5s · m mute · q quit';

/** Wait this long before showing the loading note, so fast opens never flash it */
export const LOADING_DELAY_MS = 1_000;

/** Shown centered in the reserved box while the source opens slowly */
export const LOADING_TEXT = 'loading video…';

/** Audio drifting further than this from the video clock snaps back to the playhead */
export const DRIFT_RESYNC_THRESHOLD_MS = 250;
