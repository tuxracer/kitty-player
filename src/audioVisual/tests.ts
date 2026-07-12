import { describe, expect, it, vi } from 'vitest';

import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';
import type { AudioProbeResult } from '../mediaProbe/index.ts';
import {
  normalizeAudioVisual,
  openAudioVisual,
  resolveAudioPlaceholderLabel,
} from './index.ts';

const INFO: FrameSourceInfo = {
  width: 64,
  height: 36,
  colorSpace: 'rgb24',
  durationMs: 2_000,
  fps: 10,
  hasAudio: true,
};

const WITH_ART: AudioProbeResult = {
  kind: 'audio',
  durationMs: 2_000,
  coverArt: { nativeWidth: 64, nativeHeight: 36 },
  title: 'Song title',
};

const WITHOUT_ART: AudioProbeResult = {
  kind: 'audio',
  durationMs: 2_000,
  coverArt: null,
  title: 'Song title',
};

const fakeSource = (openError?: Error): { source: FrameSource; close: ReturnType<typeof vi.fn> } => {
  const close = vi.fn(() => Promise.resolve());
  return {
    source: {
      open: () => openError === undefined ? Promise.resolve(INFO) : Promise.reject(openError),
      getFrameAt: () => Promise.resolve(null),
      seek: () => Promise.resolve(),
      close,
    },
    close,
  };
};

describe('normalizeAudioVisual', () => {
  it('maps boolean props and preserves explicit visual modes', () => {
    expect(normalizeAudioVisual(false)).toBe('none');
    expect(normalizeAudioVisual(true)).toBe('auto');
    expect(normalizeAudioVisual('artwork')).toBe('artwork');
    expect(normalizeAudioVisual('waveform')).toBe('waveform');
  });
});

describe('resolveAudioPlaceholderLabel', () => {
  it('prefers the metadata title', () => {
    expect(resolveAudioPlaceholderLabel('/music/track.mp3', 'Song title')).toBe('Song title');
  });

  it('decodes local and URL basenames without query strings', () => {
    expect(resolveAudioPlaceholderLabel('/music/track%201.mp3', null)).toBe('track 1.mp3');
    expect(resolveAudioPlaceholderLabel(
      'https://example.test/music/track%202.mp3?x=1',
      null,
    )).toBe('track 2.mp3');
  });

  it('uses the URL host for a root URL', () => {
    expect(resolveAudioPlaceholderLabel('https://example.test/', null)).toBe('example.test');
  });

  it('keeps an undecodable basename instead of throwing', () => {
    expect(resolveAudioPlaceholderLabel('/music/track%ZZ.mp3', null)).toBe('track%ZZ.mp3');
  });
});

describe('openAudioVisual', () => {
  it('opens artwork in auto mode when the supplied probe has cover art', async () => {
    const art = fakeSource();
    const waveFactory = vi.fn(() => fakeSource().source);
    const artFactory = vi.fn(() => art.source);

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'auto',
      createArtSource: artFactory,
      createWaveSource: waveFactory,
    })).resolves.toEqual({
      kind: 'source',
      visualKind: 'artwork',
      source: art.source,
      info: INFO,
      label: 'Song title',
    });
    expect(artFactory).toHaveBeenCalledWith({
      filePath: '/music/song.mp3',
      durationMs: 2_000,
      nativeWidth: 64,
      nativeHeight: 36,
    });
    expect(waveFactory).not.toHaveBeenCalled();
  });

  it('opens a waveform in auto mode when the supplied probe has no artwork', async () => {
    const wave = fakeSource();
    const waveFactory = vi.fn(() => wave.source);

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITHOUT_ART,
      mode: 'auto',
      createWaveSource: waveFactory,
    })).resolves.toMatchObject({ kind: 'source', visualKind: 'waveform', source: wave.source });
    expect(waveFactory).toHaveBeenCalledWith({
      filePath: '/music/song.mp3',
      durationMs: 2_000,
    });
  });

  it('returns a placeholder for explicit artwork when the probe has none', async () => {
    const artFactory = vi.fn(() => fakeSource().source);
    const waveFactory = vi.fn(() => fakeSource().source);

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITHOUT_ART,
      mode: 'artwork',
      createArtSource: artFactory,
      createWaveSource: waveFactory,
    })).resolves.toEqual({ kind: 'placeholder', label: 'Song title' });
    expect(artFactory).not.toHaveBeenCalled();
    expect(waveFactory).not.toHaveBeenCalled();
  });

  it('closes failed artwork and falls back to waveform only in auto mode', async () => {
    const art = fakeSource(new Error('bad artwork'));
    const wave = fakeSource();

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'auto',
      createArtSource: () => art.source,
      createWaveSource: () => wave.source,
    })).resolves.toMatchObject({ kind: 'source', visualKind: 'waveform', source: wave.source });
    expect(art.close).toHaveBeenCalledOnce();

    const explicitArt = fakeSource(new Error('bad artwork'));
    const explicitWaveFactory = vi.fn(() => fakeSource().source);
    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'artwork',
      createArtSource: () => explicitArt.source,
      createWaveSource: explicitWaveFactory,
    })).resolves.toEqual({ kind: 'placeholder', label: 'Song title' });
    expect(explicitArt.close).toHaveBeenCalledOnce();
    expect(explicitWaveFactory).not.toHaveBeenCalled();
  });

  it('closes a failed waveform and returns a placeholder', async () => {
    const wave = fakeSource(new Error('bad waveform'));

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITHOUT_ART,
      mode: 'waveform',
      createWaveSource: () => wave.source,
    })).resolves.toEqual({ kind: 'placeholder', label: 'Song title' });
    expect(wave.close).toHaveBeenCalledOnce();
  });

  it('constructs no source in none mode', async () => {
    const artFactory = vi.fn(() => fakeSource().source);
    const waveFactory = vi.fn(() => fakeSource().source);

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'none',
      createArtSource: artFactory,
      createWaveSource: waveFactory,
    })).resolves.toEqual({ kind: 'none' });
    expect(artFactory).not.toHaveBeenCalled();
    expect(waveFactory).not.toHaveBeenCalled();
  });

  it('does not swallow source construction failures', async () => {
    const error = new Error('construction failed');
    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITHOUT_ART,
      mode: 'waveform',
      createWaveSource: () => {
        throw error;
      },
    })).rejects.toBe(error);
  });
});
