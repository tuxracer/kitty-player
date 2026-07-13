import { openAudioVisual } from '../audioVisual/index.ts';
import { resolveFallbackRenderMode } from '../fallbackPlayer/index.ts';
import { createProceduralSource } from '../proceduralSource/index.ts';
import { detectFallbackReasons } from './detectFallbackReasons.ts';
import { openMediaSource } from './openMediaSource.ts';
import type {
  CliMediaPlayback,
  CliPlaybackRoute,
  ResolveMediaPlaybackOptions,
  ResolvePlaybackRouteOptions,
} from './types.ts';

export const requiresVisualTerminal = (playback: CliMediaPlayback): boolean =>
  playback.kind !== 'audio-only';

export const closeMediaPlayback = async (playback: CliMediaPlayback): Promise<void> => {
  const source = playback.kind === 'audio-only' ? null : playback.source;
  const audio = playback.kind === 'procedural' ? null : playback.audio;
  await Promise.all([
    source?.close().catch(() => undefined),
    audio?.close().catch(() => undefined),
  ]);
};

export const resolveMediaPlayback = async (
  options: ResolveMediaPlaybackOptions,
): Promise<CliMediaPlayback> => {
  if (options.filePath === undefined || options.probe === null) {
    const source = (options.createProceduralSource ?? createProceduralSource)();
    return { kind: 'procedural', source, info: await source.open() };
  }
  const probe = await options.probe;
  if (probe.kind === 'video') {
    const [{ source, info }, audio] = await Promise.all([
      (options.openVideo ?? openMediaSource)({ filePath: options.filePath, probe }),
      options.audio,
    ]);
    return { kind: 'video', source, info, audio };
  }

  const [visual, audio] = await Promise.all([
    (options.openVisual ?? openAudioVisual)({
      filePath: options.filePath,
      probe,
      mode: options.visual,
    }),
    options.audio,
  ]);
  if (visual.kind === 'source') {
    return { kind: 'audio-visual', source: visual.source, info: visual.info, audio };
  }
  return {
    kind: 'audio-only',
    durationMs: probe.durationMs,
    audio,
    label: visual.kind === 'placeholder' ? visual.label : null,
  };
};

export const resolvePlaybackRoute = async (
  options: ResolvePlaybackRouteOptions,
): Promise<CliPlaybackRoute> => {
  const { playback, renderMode } = options;
  const forceKitty = renderMode === 'kitty' && !options.fallback;
  const forcedFallback =
    options.fallback || (renderMode !== undefined && renderMode !== 'kitty');
  if (!requiresVisualTerminal(playback)) {
    return { kind: 'audio-only', fallback: forcedFallback };
  }

  try {
    const resolveFallbackMode = options.resolveFallbackMode ?? resolveFallbackRenderMode;
    if (forcedFallback) {
      return {
        kind: 'visual',
        forceKitty: false,
        fallbackMode: await resolveFallbackMode(renderMode),
        reasons: [],
      };
    }
    if (forceKitty) {
      return { kind: 'visual', forceKitty: true, reasons: [] };
    }

    const reasons = (options.detectReasons ?? detectFallbackReasons)();
    if (reasons.length === 0) {
      return { kind: 'visual', forceKitty: false, reasons };
    }
    return {
      kind: 'visual',
      forceKitty: false,
      fallbackMode: await resolveFallbackMode(),
      reasons,
    };
  } catch (error) {
    await closeMediaPlayback(playback);
    throw error;
  }
};
