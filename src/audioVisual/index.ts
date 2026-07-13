import { basename } from 'node:path';

import { createCoverArtSource } from '../coverArtSource/index.ts';
import type { FrameSource } from '../frameSource/index.ts';
import { createWaveformSource } from '../waveformSource/index.ts';
import type {
  AudioVisualMode,
  AudioVisualProp,
  AudioVisualSelection,
  OpenAudioVisualOptions,
} from './types.ts';

export * from './consts.ts';
export * from './types.ts';

export const normalizeAudioVisual = (visual: AudioVisualProp = false): AudioVisualMode => {
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
    fileName = url.pathname.endsWith('/') ? '' : basename(url.pathname);
  } catch {
    fileName = filePath.endsWith('/') ? '' : basename(filePath);
  }
  if (fileName === '') {
    return filePath;
  }
  try {
    return decodeURIComponent(fileName);
  } catch {
    return fileName;
  }
};

const openSource = async (
  createSource: () => FrameSource,
  visualKind: 'artwork' | 'waveform',
  label: string,
): Promise<AudioVisualSelection | null> => {
  let source: FrameSource | null = null;
  try {
    source = createSource();
    const info = await source.open();
    return { kind: 'source', visualKind, source, info, label };
  } catch {
    if (source !== null) {
      try {
        await source.close();
      } catch {
        // Visual cleanup cannot abort audio playback.
      }
    }
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
    const coverArt = probe.coverArt;
    if (coverArt === null) {
      return placeholder;
    }
    const createArtSource = options.createArtSource ?? createCoverArtSource;
    return await openSource(() => createArtSource({
      filePath,
      durationMs: probe.durationMs,
      nativeWidth: coverArt.nativeWidth,
      nativeHeight: coverArt.nativeHeight,
    }), 'artwork', label) ?? placeholder;
  }

  if (mode === 'auto' && probe.coverArt !== null) {
    const coverArt = probe.coverArt;
    const createArtSource = options.createArtSource ?? createCoverArtSource;
    const artwork = await openSource(() => createArtSource({
      filePath,
      durationMs: probe.durationMs,
      nativeWidth: coverArt.nativeWidth,
      nativeHeight: coverArt.nativeHeight,
    }), 'artwork', label);
    if (artwork !== null) {
      return artwork;
    }
  }

  const createWaveSource = options.createWaveSource ?? createWaveformSource;
  return await openSource(() => createWaveSource({
    filePath,
    durationMs: probe.durationMs,
  }), 'waveform', label) ?? placeholder;
};
