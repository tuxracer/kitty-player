import { Screen, detectKittyUnicodePlaceholderSupport } from 'kitty-motion';

import type { ManagedScreenOptions, PlayerScreen } from './types.ts';

/**
 * True when this process can display video placeholders: stdout is a TTY and
 * the terminal advertises kitty unicode placeholder support. Both checks are
 * synchronous and env-based, no terminal round trip.
 *
 * `isTTY` is compared with `=== true` rather than used directly: the Node
 * typings declare it as a plain `boolean`, but at runtime it is `undefined`
 * (not `false`) off a TTY, so a bare `&&` would leak `undefined` out of a
 * function typed to return `boolean`.
 */
export const canDisplayVideo = (): boolean =>
  process.stdout.isTTY === true && detectKittyUnicodePlaceholderSupport();

/**
 * Construct a Screen synchronously with every probe-dependent option forced,
 * so no stdin reads ever happen while Ink owns stdin (createScreen's async
 * probes read stdin and would fight Ink for it). renderMode skips the
 * graphics probe, fileTransfer false skips the file-transfer probe and temp
 * file setup, dirtyRects false skips the animation probe (and is the
 * verified-good configuration). Cell pixel size falls back to kitty-motion's
 * 9x18 defaults when unprobed.
 */
export const createManagedScreen = ({
  region,
  sourceWidth,
  sourceHeight,
  colorSpace,
}: ManagedScreenOptions): PlayerScreen =>
  new Screen({
    output: process.stdout,
    sourceWidth,
    sourceHeight,
    colorSpace,
    placement: 'unicode',
    renderMode: 'kitty',
    fileTransfer: false,
    dirtyRects: false,
    embedded: true,
    region,
    autoResize: false,
    autoDispose: false,
  });
