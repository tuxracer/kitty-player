import { basename } from 'node:path';

import { createCoverArtSource } from '../coverArtSource/index.ts';
import type { FrameSource } from '../frameSource/index.ts';
import { createWaveformSource } from '../waveformSource/index.ts';
import { DEFAULT_AUDIO_PLACEHOLDER_LABEL } from './consts.ts';
import type {
  AudioVisualMode,
  AudioVisualProp,
  AudioVisualSelection,
  OpenAudioVisualOptions,
} from './types.ts';

export * from './consts.ts';
export * from './types.ts';

export const normalizeAudioVisual = (visual: AudioVisualProp): AudioVisualMode => {
  if (visual === false) {
    return 'none';
  }
  if (visual === true) {
    return 'auto';
  }
  return visual;
};

export const resolveAudioPlaceholderLabel = (filePath: string, title: string | null): string => {
  if (title !== null && title.trim() !== '') {
    return title.trim();
  }

  let fileName: string;
  try {
    const url = new URL(filePath);
    fileName = basename(url.pathname) || url.hostname;
  } catch {
    fileName = basename(filePath);
  }
  if (fileName === '') {
    return DEFAULT_AUDIO_PLACEHOLDER_LABEL;
  }
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
};

const openSource = async (
  source: FrameSource,
  visualKind: 'artwork' | 'waveform',
  label: string,
): Promise<AudioVisualSelection | null> => {
  try {
    const info = await source.open();
    return { kind: 'source', visualKind, source, info, label };
  } catch {
    await source.close();
    return null;
  }
};

export const openAudioVisual = async (
  options: OpenAudioVisualOptions,
): Promise<AudioVisualSelection> => {
  const { filePath, probe, mode } = options;
  if (mode === 'none') {
    return { kind: 'none' };
  }

  const label = resolveAudioPlaceholderLabel(filePath, probe.title);
  const placeholder: AudioVisualSelection = { kind: 'placeholder', label };

  if (mode === 'artwork') {
    if (probe.coverArt === null) {
      return placeholder;
    }
    const source = (options.createArtSource ?? createCoverArtSource)({
      filePath,
      durationMs: probe.durationMs,
      nativeWidth: probe.coverArt.nativeWidth,
      nativeHeight: probe.coverArt.nativeHeight,
    });
    return await openSource(source, 'artwork', label) ?? placeholder;
  }

  if (mode === 'auto' && probe.coverArt !== null) {
    const source = (options.createArtSource ?? createCoverArtSource)({
      filePath,
      durationMs: probe.durationMs,
      nativeWidth: probe.coverArt.nativeWidth,
      nativeHeight: probe.coverArt.nativeHeight,
    });
    const artwork = await openSource(source, 'artwork', label);
    if (artwork !== null) {
      return artwork;
    }
  }

  const source = (options.createWaveSource ?? createWaveformSource)({
    filePath,
    durationMs: probe.durationMs,
  });
  return await openSource(source, 'waveform', label) ?? placeholder;
};
