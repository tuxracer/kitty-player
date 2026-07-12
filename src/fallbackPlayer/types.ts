import type { CellRenderMode } from 'kitty-motion';
import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';

/** Injectable detection seams for resolveFallbackRenderMode, defaulted to kitty-motion's detectors */
export interface ResolveFallbackRenderModeOptions {
  /** Async kitty graphics probe (detectKittyGraphicsSupport in production) */
  probeKittyGraphics?: () => Promise<boolean>;
  /** Cell mode chooser (detectCellRenderMode in production) */
  detectCellMode?: () => CellRenderMode;
  /** Multiplexed-session check (isMultiplexedSession in production) */
  isMultiplexed?: () => boolean;
}

/**
 * Structural subset of kitty-motion's Screen that the fallback player uses,
 * so tests can pass a plain fake without casts. Narrower than PlayerScreen
 * because the cell renderer has no placeholder rows or region to manage.
 */
export interface FallbackScreen {
  pushFrame(frame: Uint8Array): void;
  isWritable(): boolean;
  dispose(): void;
}

/**
 * Structural subset of process.stdin that the key handler uses. setRawMode,
 * resume, and pause are optional because fakes and non-TTY streams lack them.
 */
export interface FallbackKeyInput {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
  setRawMode?(mode: boolean): unknown;
  resume?(): void;
  pause?(): void;
}

export interface FallbackPlayerOptions {
  screen: FallbackScreen;
  source: FrameSource;
  info: FrameSourceInfo;
  /** Key event stream (process.stdin in production) */
  input: FallbackKeyInput;
}
