/** Milliseconds per second, for timestamp math (per-module duplicate, see src/index.ts) */
export const MS_PER_SECOND = 1_000;

/** Microseconds per millisecond, for ffmpeg progress timestamps (out_time_us) */
export const MICROSECONDS_PER_MS = 1_000;

/** A half rotation in degrees, for reducing display-matrix rotation to its quarter-turn remainder */
export const HALF_ROTATION_DEGREES = 180;

/** A quarter rotation in degrees, the remainder that means width and height swap */
export const QUARTER_ROTATION_DEGREES = 90;
