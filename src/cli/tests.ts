import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOADING_DELAY_MS } from '../Video/index.tsx';
// Import from parseCliArgs.ts directly (not ./index.tsx) because importing
// the entry module would run the CLI at module top level.
import { parseCliArgs } from './parseCliArgs.ts';
import { detectFallbackReasons } from './detectFallbackReasons.ts';
import { confirmFallback } from './confirmFallback.ts';
import { startLoadingIndicator } from './loadingIndicator.ts';
import { CLEAR_LINE, FALLBACK_PROMPT, RENDER_MODES, SPINNER_INTERVAL_MS } from './consts.ts';
import { isRenderMode } from './types.ts';
import type { LoadingIndicatorOutput } from './types.ts';
import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';
import type { AudioProbeResult, VideoProbeResult } from '../mediaProbe/index.ts';
import { openMediaSource } from './openMediaSource.ts';

describe('parseCliArgs', () => {
  it('returns play when no arguments are given', () => {
    expect(parseCliArgs([])).toEqual({ action: 'play', fallback: false, muted: false });
  });

  it('returns help for --help', () => {
    expect(parseCliArgs(['--help'])).toEqual({ action: 'help' });
  });

  it('returns help for -h', () => {
    expect(parseCliArgs(['-h'])).toEqual({ action: 'help' });
  });

  it('returns version for --version', () => {
    expect(parseCliArgs(['--version'])).toEqual({ action: 'version' });
  });

  it('returns version for -v', () => {
    expect(parseCliArgs(['-v'])).toEqual({ action: 'version' });
  });

  it('returns play with the file for a positional argument', () => {
    expect(parseCliArgs(['movie.mp4'])).toEqual({
      action: 'play',
      file: 'movie.mp4',
      fallback: false,
      muted: false,
    });
  });

  it('passes an http(s) URL positional through as the file', () => {
    expect(parseCliArgs(['https://example.com/movie.mp4'])).toEqual({
      action: 'play',
      file: 'https://example.com/movie.mp4',
      fallback: false,
      muted: false,
    });
  });

  it('returns play with fallback for --fallback', () => {
    expect(parseCliArgs(['--fallback'])).toEqual({ action: 'play', fallback: true, muted: false });
  });

  it('combines --fallback with a file argument', () => {
    expect(parseCliArgs(['--fallback', 'movie.mp4'])).toEqual({
      action: 'play',
      file: 'movie.mp4',
      fallback: true,
      muted: false,
    });
  });

  it.each(['kitty', 'half-block', 'cell-background', 'emoji', 'ascii'])(
    'parses --render-mode %s without implying fallback',
    (mode) => {
      expect(parseCliArgs(['--render-mode', mode])).toEqual({
        action: 'play',
        fallback: false,
        muted: false,
        renderMode: mode,
      });
    },
  );

  it('parses --muted into the play action', () => {
    expect(parseCliArgs(['--muted'])).toEqual({ action: 'play', fallback: false, muted: true });
  });

  it('defaults muted to false', () => {
    expect(parseCliArgs([])).toEqual({ action: 'play', fallback: false, muted: false });
  });

  it('combines --muted with a file argument', () => {
    expect(parseCliArgs(['--muted', 'movie.mp4'])).toEqual({
      action: 'play',
      fallback: false,
      muted: true,
      file: 'movie.mp4',
    });
  });

  it('returns usage-error for an invalid --render-mode value naming the valid modes', () => {
    const result = parseCliArgs(['--render-mode', 'bogus']);
    expect(result.action).toBe('usage-error');
    if (result.action === 'usage-error') {
      expect(result.message).toContain('bogus');
      expect(result.message).toContain('cell-background');
    }
  });

  it('parses --fallback with --render-mode kitty (the gate resolves the combination to kitty without controls)', () => {
    expect(parseCliArgs(['--fallback', '--render-mode', 'kitty'])).toEqual({
      action: 'play',
      fallback: true,
      muted: false,
      renderMode: 'kitty',
    });
  });

  it('returns usage-error for more than one positional argument', () => {
    const result = parseCliArgs(['a.mp4', 'b.mp4']);
    expect(result.action).toBe('usage-error');
    if (result.action === 'usage-error') {
      expect(result.message).toContain('b.mp4');
    }
  });

  it('prefers help over a positional file', () => {
    expect(parseCliArgs(['--help', 'movie.mp4'])).toEqual({ action: 'help' });
  });

  it('prefers help over version when both flags are given', () => {
    expect(parseCliArgs(['--version', '--help'])).toEqual({ action: 'help' });
  });

  it('returns usage-error with a message naming an unknown flag', () => {
    const result = parseCliArgs(['--bogus']);
    expect(result.action).toBe('usage-error');
    if (result.action === 'usage-error') {
      expect(result.message).toContain('--bogus');
    }
  });

  it('returns usage-error for an unknown short flag', () => {
    const result = parseCliArgs(['-x']);
    expect(result.action).toBe('usage-error');
  });
});

describe('isRenderMode', () => {
  it.each([...RENDER_MODES])('accepts %s', (mode) => {
    expect(isRenderMode(mode)).toBe(true);
  });

  it.each(['bogus', '', 'KITTY', 42, null, undefined])('rejects %j', (value) => {
    expect(isRenderMode(value)).toBe(false);
  });
});

describe('detectFallbackReasons', () => {
  it('returns no reasons for a kitty terminal outside a multiplexer', () => {
    expect(detectFallbackReasons({ TERM: 'xterm-kitty' })).toEqual([]);
  });

  it('returns no reasons for a ghostty terminal', () => {
    expect(detectFallbackReasons({ TERM_PROGRAM: 'ghostty' })).toEqual([]);
  });

  it('reports missing placeholder support on a generic terminal', () => {
    expect(detectFallbackReasons({ TERM: 'xterm-256color' })).toEqual(['no-placeholder-support']);
  });

  it('reports a multiplexed session when TMUX is set on a kitty terminal', () => {
    expect(
      detectFallbackReasons({ TERM: 'xterm-kitty', TMUX: '/tmp/tmux-1000/default,42,0' }),
    ).toEqual(['multiplexed-session']);
  });

  it('reports both reasons inside GNU screen on a generic terminal', () => {
    const reasons = detectFallbackReasons({ TERM: 'screen-256color', STY: '1234.pts-0.host' });
    expect(reasons).toContain('no-placeholder-support');
    expect(reasons).toContain('multiplexed-session');
  });
});

describe('confirmFallback', () => {
  /** Run confirmFallback against fake streams, feeding one answer line (or EOF when undefined) */
  const ask = async (answer?: string, prompt: string = FALLBACK_PROMPT): Promise<{ accepted: boolean; prompted: string }> => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = confirmFallback({ input, output, prompt });
    if (answer === undefined) {
      input.end();
    } else {
      input.write(answer);
    }
    const accepted = await pending;
    const prompted = String(output.read() ?? '');
    return { accepted, prompted };
  };

  it('writes the provided prompt to the output stream', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = confirmFallback({ input, output, prompt: 'Play anyway? [y/N] ' });
    input.write('n\n');
    await pending;
    expect(String(output.read() ?? '')).toBe('Play anyway? [y/N] ');
  });

  it.each(['y\n', 'Y\n', 'yes\n', ' YES \n'])('accepts %j', async (answer) => {
    const { accepted } = await ask(answer);
    expect(accepted).toBe(true);
  });

  it.each(['n\n', 'no\n', '\n', 'yep\n'])('declines %j', async (answer) => {
    const { accepted } = await ask(answer);
    expect(accepted).toBe(false);
  });

  it('declines on EOF without an answer', async () => {
    const { accepted } = await ask(undefined);
    expect(accepted).toBe(false);
  });

  it('declines when the input stream errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = confirmFallback({ input, output, prompt: FALLBACK_PROMPT });
    input.emit('error', new Error('boom'));
    await expect(pending).resolves.toBe(false);
  });
});

describe('startLoadingIndicator', () => {
  interface CaptureOutput extends LoadingIndicatorOutput {
    writes: string[];
  }

  const createOutput = (isTTY: boolean): CaptureOutput => {
    const output: CaptureOutput = {
      isTTY,
      writes: [],
      write: (text: string) => {
        output.writes.push(text);
        return true;
      },
    };
    return output;
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays silent when stopped before the delay', () => {
    const output = createOutput(true);
    const indicator = startLoadingIndicator('movie.mp4', output);
    vi.advanceTimersByTime(LOADING_DELAY_MS - 1);
    indicator.stop();
    vi.advanceTimersByTime(LOADING_DELAY_MS * 2);
    expect(output.writes).toEqual([]);
  });

  it('animates spinner frames on a TTY and erases the line on stop', () => {
    const output = createOutput(true);
    const indicator = startLoadingIndicator('http://example.com/movie.mp4', output);
    vi.advanceTimersByTime(LOADING_DELAY_MS + SPINNER_INTERVAL_MS * 3);
    // The first frame draws when the delay fires, then one per interval
    expect(output.writes.length).toBe(4);
    expect(output.writes[0]).toContain('loading http://example.com/movie.mp4');
    expect(output.writes[0].startsWith('\r')).toBe(true);
    // Frames advance, so consecutive writes differ
    expect(output.writes[1]).not.toBe(output.writes[0]);
    indicator.stop();
    expect(output.writes.at(-1)).toBe(CLEAR_LINE);
    // Stopped for good: no more frames, and stop stays idempotent
    vi.advanceTimersByTime(SPINNER_INTERVAL_MS * 5);
    indicator.stop();
    expect(output.writes.at(-1)).toBe(CLEAR_LINE);
    expect(output.writes.filter((text) => text === CLEAR_LINE).length).toBe(1);
  });

  it('prints a single plain notice when the output is not a TTY', () => {
    const output = createOutput(false);
    const indicator = startLoadingIndicator('movie.mp4', output);
    vi.advanceTimersByTime(LOADING_DELAY_MS + SPINNER_INTERVAL_MS * 5);
    expect(output.writes).toEqual(['kitty-media-player: loading movie.mp4…\n']);
    indicator.stop();
    // Nothing to erase on a non-TTY, the notice line stays
    expect(output.writes.length).toBe(1);
  });
});

describe('openMediaSource', () => {
  const fakeInfo = (width: number): FrameSourceInfo => ({
    width,
    height: 36,
    colorSpace: 'rgb24',
    durationMs: 2_000,
    fps: 10,
    hasAudio: true,
  });

  interface FakeSource extends FrameSource {
    closed: boolean;
  }

  const fakeSource = (info: FrameSourceInfo, openError?: Error): FakeSource => {
    const source: FakeSource = {
      closed: false,
      open: () => (openError === undefined ? Promise.resolve(info) : Promise.reject(openError)),
      getFrameAt: () => Promise.resolve(null),
      seek: () => Promise.resolve(),
      close: () => {
        source.closed = true;
        return Promise.resolve();
      },
    };
    return source;
  };

  const videoProbe: VideoProbeResult = {
    kind: 'video',
    nativeWidth: 64,
    nativeHeight: 36,
    durationMs: 2_000,
    fps: 10,
    hasAudio: true,
  };

  const artProbe: AudioProbeResult = {
    kind: 'audio',
    durationMs: 2_000,
    coverArt: { nativeWidth: 64, nativeHeight: 36 },
  };

  const bareAudioProbe: AudioProbeResult = { kind: 'audio', durationMs: 2_000, coverArt: null };

  it('opens the video source for a video probe, passing the probe through', async () => {
    const video = fakeSource(fakeInfo(1));
    let received: unknown;
    const opened = await openMediaSource({
      filePath: 'movie.mp4',
      probe: videoProbe,
      createVideoSource: (options) => {
        received = options.probe;
        return video;
      },
      createArtSource: () => {
        throw new Error('art source must not be constructed for video');
      },
      createWaveSource: () => {
        throw new Error('waveform must not be constructed for video');
      },
    });
    expect(opened.source).toBe(video);
    expect(opened.info.width).toBe(1);
    expect(received).toBe(videoProbe);
  });

  it('opens the cover art source for an audio probe with art', async () => {
    const art = fakeSource(fakeInfo(2));
    const opened = await openMediaSource({
      filePath: 'song.mp3',
      probe: artProbe,
      createVideoSource: () => {
        throw new Error('video source must not be constructed for audio');
      },
      createArtSource: () => art,
      createWaveSource: () => {
        throw new Error('waveform must not be constructed when art decodes');
      },
    });
    expect(opened.source).toBe(art);
    expect(opened.info.width).toBe(2);
  });

  it('falls back to the waveform when the art fails to decode, closing the art source', async () => {
    const art = fakeSource(fakeInfo(2), new Error('no art'));
    const wave = fakeSource(fakeInfo(3));
    const opened = await openMediaSource({
      filePath: 'song.mp3',
      probe: artProbe,
      createArtSource: () => art,
      createWaveSource: (options) => {
        expect(options.durationMs).toBe(2_000);
        return wave;
      },
    });
    expect(opened.source).toBe(wave);
    expect(opened.info.width).toBe(3);
    expect(art.closed).toBe(true);
  });

  it('opens the waveform directly for an audio probe without art', async () => {
    const wave = fakeSource(fakeInfo(3));
    const opened = await openMediaSource({
      filePath: 'song.mp3',
      probe: bareAudioProbe,
      createArtSource: () => {
        throw new Error('art source must not be constructed without art');
      },
      createWaveSource: () => wave,
    });
    expect(opened.source).toBe(wave);
  });
});
