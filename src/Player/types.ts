import type { ScreenRegion } from 'kitty-motion';

import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';

/**
 * Structural subset of kitty-motion's Screen that the player uses, so tests
 * can pass a plain fake without casts.
 */
export interface PlayerScreen {
  getPlaceholderRows(): string[];
  pushFrame(frame: Uint8Array): void;
  setRegion(region: ScreenRegion): void;
  isWritable(): boolean;
  dispose(): void;
}

export interface PlayerProps {
  screen: PlayerScreen;
  source: FrameSource;
  info: FrameSourceInfo;
}
