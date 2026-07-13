import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';
import type { AudioProbeResult } from '../mediaProbe/index.ts';
import {
  normalizeAudioVisual,
  openAudioVisual,
  resolveAudioPlaceholderLabel,
} from './index.ts';
import type { AudioVisualProp } from './index.ts';

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
  it('accepts exactly the public visual prop values', () => {
    expectTypeOf<AudioVisualProp>().toEqualTypeOf<boolean | 'artwork' | 'waveform'>();
  });

  it('maps boolean props and preserves explicit visual modes', () => {
    expect(normalizeAudioVisual()).toBe('none');
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

  it('uses the original source when there is no basename', () => {
    expect(resolveAudioPlaceholderLabel('https://example.test/', null)).toBe(
      'https://example.test/',
    );
    expect(resolveAudioPlaceholderLabel('/', null)).toBe('/');
  });

  it('keeps an undecodable basename instead of throwing', () => {
    expect(resolveAudioPlaceholderLabel('/music/track%ZZ.mp3', null)).toBe('track%ZZ.mp3');
    expect(resolveAudioPlaceholderLabel(
      'https://example.test/music/track%ZZ.mp3?x=1',
      null,
    )).toBe('track%ZZ.mp3');
  });
});

describe('openAudioVisual', () => {
  it('opens artwork in explicit artwork mode', async () => {
    const art = fakeSource();

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'artwork',
      createArtSource: () => art.source,
    })).resolves.toMatchObject({ kind: 'source', visualKind: 'artwork', source: art.source });
  });

  it('opens a waveform in explicit waveform mode', async () => {
    const wave = fakeSource();

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITHOUT_ART,
      mode: 'waveform',
      createWaveSource: () => wave.source,
    })).resolves.toMatchObject({ kind: 'source', visualKind: 'waveform', source: wave.source });
  });

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

  it('waits for failed artwork cleanup before constructing the waveform', async () => {
    const events: string[] = [];
    let resolveClose = (): void => undefined;
    const closeDone = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const art = fakeSource(new Error('bad artwork'));
    art.source.close = vi.fn(() => {
      events.push('artwork close');
      return closeDone;
    });
    const wave = fakeSource();
    const waveFactory = vi.fn(() => {
      events.push('waveform construct');
      return wave.source;
    });

    const selection = openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'auto',
      createArtSource: () => art.source,
      createWaveSource: waveFactory,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['artwork close']);
    expect(waveFactory).not.toHaveBeenCalled();

    resolveClose();
    await expect(selection).resolves.toMatchObject({ kind: 'source', visualKind: 'waveform' });
    expect(events).toEqual(['artwork close', 'waveform construct']);
  });

  it('returns a placeholder after closing failed artwork and waveform sources', async () => {
    const art = fakeSource(new Error('bad artwork'));
    const wave = fakeSource(new Error('bad waveform'));

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'auto',
      createArtSource: () => art.source,
      createWaveSource: () => wave.source,
    })).resolves.toEqual({ kind: 'placeholder', label: 'Song title' });
    expect(art.close).toHaveBeenCalledOnce();
    expect(wave.close).toHaveBeenCalledOnce();
  });

  it('falls back to waveform when the auto artwork factory throws', async () => {
    const wave = fakeSource();

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'auto',
      createArtSource: () => {
        throw new Error('artwork construction failed');
      },
      createWaveSource: () => wave.source,
    })).resolves.toMatchObject({ kind: 'source', visualKind: 'waveform', source: wave.source });
  });

  it('returns a placeholder when a forced visual factory throws', async () => {
    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'artwork',
      createArtSource: () => {
        throw new Error('artwork construction failed');
      },
    })).resolves.toEqual({ kind: 'placeholder', label: 'Song title' });

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITHOUT_ART,
      mode: 'waveform',
      createWaveSource: () => {
        throw new Error('waveform construction failed');
      },
    })).resolves.toEqual({ kind: 'placeholder', label: 'Song title' });
  });

  it('ignores rejected artwork cleanup before auto waveform fallback', async () => {
    const art = fakeSource(new Error('bad artwork'));
    art.source.close = () => Promise.reject(new Error('artwork cleanup failed'));
    const wave = fakeSource();

    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'auto',
      createArtSource: () => art.source,
      createWaveSource: () => wave.source,
    })).resolves.toMatchObject({ kind: 'source', visualKind: 'waveform', source: wave.source });
  });

  it('ignores rejected cleanup for failed forced visuals', async () => {
    const art = fakeSource(new Error('bad artwork'));
    art.source.close = () => Promise.reject(new Error('artwork cleanup failed'));
    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITH_ART,
      mode: 'artwork',
      createArtSource: () => art.source,
    })).resolves.toEqual({ kind: 'placeholder', label: 'Song title' });

    const wave = fakeSource(new Error('bad waveform'));
    wave.source.close = () => Promise.reject(new Error('waveform cleanup failed'));
    await expect(openAudioVisual({
      filePath: '/music/song.mp3',
      probe: WITHOUT_ART,
      mode: 'waveform',
      createWaveSource: () => wave.source,
    })).resolves.toEqual({ kind: 'placeholder', label: 'Song title' });
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

});
