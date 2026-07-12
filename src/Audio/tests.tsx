import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { createRef, forwardRef, useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AudioPlayer } from '../audioPlayer/index.ts';
import type { FfmpegAudioPlayerOptions } from '../ffmpegAudioPlayer/index.ts';
import { MediaProbeError } from '../mediaProbe/index.ts';
import {
  AUDIO_TICK_MS,
  BUFFERING_TEXT,
  DRIFT_RESYNC_THRESHOLD_MS,
  LOADING_DELAY_MS,
  LOADING_TEXT,
  PAUSE_GLYPH,
} from './consts.ts';
import { AudioError } from './types.ts';
import type {
  AudioLoadedMetadataEvent,
  AudioRef,
  AudioPlaybackClock,
  AudioPlaybackClockOptions,
  ManagedAudioResourcesOptions,
} from './types.ts';
import { Audio } from './index.tsx';
import { useAudioPlaybackClock } from './useAudioPlaybackClock.ts';
import { useManagedResources } from './useManagedResources.ts';

const mediaProbeMocks = vi.hoisted(() => ({
  probeMediaFile: vi.fn(),
}));

const ffmpegAudioMocks = vi.hoisted(() => ({
  createFfmpegAudioPlayer: vi.fn(),
}));

const appMocks = vi.hoisted(() => ({
  exit: vi.fn(),
}));

vi.mock('ink', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ink')>()),
  useApp: () => ({ exit: appMocks.exit }),
}));
vi.mock('../mediaProbe/index.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mediaProbe/index.ts')>()),
  ...mediaProbeMocks,
}));
vi.mock('../ffmpegAudioPlayer/index.ts', () => ffmpegAudioMocks);

interface FakeAudioHarness {
  audio: AudioPlayer;
  playFroms: number[];
  pauseCalls: number;
  mutedValues: boolean[];
  closeCalls: number;
  starting: boolean;
  positionMs: number | null;
}

const createFakeAudio = (): FakeAudioHarness => {
  const harness: FakeAudioHarness = {
    playFroms: [],
    pauseCalls: 0,
    mutedValues: [],
    closeCalls: 0,
    starting: false,
    positionMs: null,
    audio: {
      open: () => Promise.resolve({ hasAudio: true }),
      playFrom: (timeMs) => {
        harness.playFroms.push(timeMs);
      },
      pause: () => {
        harness.pauseCalls += 1;
      },
      setMuted: (muted) => {
        harness.mutedValues.push(muted);
      },
      isStarting: () => harness.starting,
      getPositionMs: () => harness.positionMs,
      close: () => {
        harness.closeCalls += 1;
        return Promise.resolve();
      },
    },
  };
  return harness;
};

const ClockHarness = forwardRef<AudioPlaybackClock, AudioPlaybackClockOptions>((props, ref) => {
  const clock = useAudioPlaybackClock(props);
  useImperativeHandle(ref, () => clock, [clock]);
  return null;
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

const settle = async (): Promise<void> => {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const createDeferred = <T,>(): Deferred<T> => {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
};

const mockSuccessfulLoad = (harness: FakeAudioHarness, durationMs: number): void => {
  mediaProbeMocks.probeMediaFile.mockResolvedValue({
    kind: 'audio',
    durationMs,
    coverArt: null,
    title: null,
  });
  ffmpegAudioMocks.createFfmpegAudioPlayer.mockReturnValue(harness.audio);
};

const ManagedResourcesHarness = (props: ManagedAudioResourcesOptions) => {
  const resources = useManagedResources(props);
  return <Text>{`${resources.status}:${resources.durationMs ?? 'null'}`}</Text>;
};

describe('useManagedResources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens audio and reports duration metadata in seconds', async () => {
    const harness = createFakeAudio();
    const onLoadedMetadata = vi.fn();
    mediaProbeMocks.probeMediaFile.mockResolvedValue({
      kind: 'audio',
      durationMs: 20_000,
      coverArt: null,
      title: null,
    });
    ffmpegAudioMocks.createFfmpegAudioPlayer.mockReturnValue(harness.audio);

    const view = render(
      <ManagedResourcesHarness src="track.mp3" onLoadedMetadata={onLoadedMetadata} />,
    );
    await settle();

    expect(view.lastFrame()).toContain('ready:20000');
    expect(onLoadedMetadata).toHaveBeenCalledOnce();
    expect(onLoadedMetadata).toHaveBeenCalledWith({ duration: 20 });
    view.unmount();
  });

  it('accepts a video probe that contains audio', async () => {
    const harness = createFakeAudio();
    mediaProbeMocks.probeMediaFile.mockResolvedValue({
      kind: 'video',
      nativeWidth: 640,
      nativeHeight: 360,
      durationMs: 20_000,
      fps: 30,
      hasAudio: true,
    });
    ffmpegAudioMocks.createFfmpegAudioPlayer.mockReturnValue(harness.audio);

    const view = render(<ManagedResourcesHarness src="clip.mp4" />);
    await settle();

    expect(view.lastFrame()).toContain('ready:20000');
    view.unmount();
  });

  it('uses the pending media probe for the player audio probe', async () => {
    const harness = createFakeAudio();
    mediaProbeMocks.probeMediaFile.mockResolvedValue({
      kind: 'audio',
      durationMs: 20_000,
      coverArt: null,
      title: null,
    });
    ffmpegAudioMocks.createFfmpegAudioPlayer.mockImplementation(
      (options: FfmpegAudioPlayerOptions) => ({
        ...harness.audio,
        open: async () => ({ hasAudio: (await options.probeAudio?.()) ?? false }),
      }),
    );

    const view = render(<ManagedResourcesHarness src="track.mp3" />);
    await settle();

    expect(view.lastFrame()).toContain('ready:20000');
    expect(mediaProbeMocks.probeMediaFile).toHaveBeenCalledOnce();
    expect(mediaProbeMocks.probeMediaFile).toHaveBeenCalledWith('track.mp3');
    view.unmount();
  });

  it('rejects a video without an audio stream and closes the player', async () => {
    const harness = createFakeAudio();
    const onError = vi.fn();
    mediaProbeMocks.probeMediaFile.mockResolvedValue({
      kind: 'video',
      nativeWidth: 640,
      nativeHeight: 360,
      durationMs: 20_000,
      fps: 30,
      hasAudio: false,
    });
    ffmpegAudioMocks.createFfmpegAudioPlayer.mockReturnValue(harness.audio);

    const view = render(<ManagedResourcesHarness src="silent.mp4" onError={onError} />);
    await settle();

    expect(view.lastFrame()).toContain('error:null');
    expect(onError).toHaveBeenCalledWith(new AudioError('NO_AUDIO_STREAM'));
    expect(harness.closeCalls).toBe(1);
    view.unmount();
  });

  it('reports unavailable audio output after confirming the stream', async () => {
    const harness = createFakeAudio();
    const onError = vi.fn();
    harness.audio.open = () => Promise.resolve({ hasAudio: false });
    mediaProbeMocks.probeMediaFile.mockResolvedValue({
      kind: 'audio',
      durationMs: 20_000,
      coverArt: null,
      title: null,
    });
    ffmpegAudioMocks.createFfmpegAudioPlayer.mockReturnValue(harness.audio);

    const view = render(<ManagedResourcesHarness src="track.mp3" onError={onError} />);
    await settle();

    expect(view.lastFrame()).toContain('error:null');
    expect(onError).toHaveBeenCalledWith(new AudioError('AUDIO_UNAVAILABLE'));
    expect(harness.closeCalls).toBe(1);
    view.unmount();
  });

  it('passes through a typed media probe failure', async () => {
    const harness = createFakeAudio();
    const onError = vi.fn();
    const error = new MediaProbeError('FILE_NOT_FOUND', 'missing');
    mediaProbeMocks.probeMediaFile.mockRejectedValue(error);
    ffmpegAudioMocks.createFfmpegAudioPlayer.mockReturnValue(harness.audio);

    const view = render(<ManagedResourcesHarness src="missing.mp3" onError={onError} />);
    await settle();

    expect(view.lastFrame()).toContain('error:null');
    expect(onError).toHaveBeenCalledWith(error);
    expect(harness.closeCalls).toBe(1);
    view.unmount();
  });

  it('closes the old player and resets to loading when src changes', async () => {
    const first = createFakeAudio();
    const second = createFakeAudio();
    const secondProbe = createDeferred<{
      kind: 'audio';
      durationMs: number;
      coverArt: null;
      title: null;
    }>();
    mediaProbeMocks.probeMediaFile
      .mockResolvedValueOnce({ kind: 'audio', durationMs: 20_000, coverArt: null, title: null })
      .mockReturnValueOnce(secondProbe.promise);
    ffmpegAudioMocks.createFfmpegAudioPlayer
      .mockReturnValueOnce(first.audio)
      .mockReturnValueOnce(second.audio);
    const view = render(<ManagedResourcesHarness src="first.mp3" />);
    await settle();
    expect(view.lastFrame()).toContain('ready:20000');

    view.rerender(<ManagedResourcesHarness src="second.mp3" />);
    await settle();
    expect(view.lastFrame()).toContain('loading:null');
    expect(first.closeCalls).toBe(1);

    secondProbe.resolve({ kind: 'audio', durationMs: 10_000, coverArt: null, title: null });
    await settle();
    expect(view.lastFrame()).toContain('ready:10000');
    view.unmount();
  });

  it('closes an unresolved open on unmount without reporting callbacks', async () => {
    const harness = createFakeAudio();
    const probe = createDeferred<{
      kind: 'audio';
      durationMs: number;
      coverArt: null;
      title: null;
    }>();
    const open = createDeferred<{ hasAudio: boolean }>();
    harness.audio.open = () => open.promise;
    const onLoadedMetadata = vi.fn();
    const onError = vi.fn();
    mediaProbeMocks.probeMediaFile.mockReturnValue(probe.promise);
    ffmpegAudioMocks.createFfmpegAudioPlayer.mockReturnValue(harness.audio);
    const view = render(
      <ManagedResourcesHarness
        src="track.mp3"
        onLoadedMetadata={onLoadedMetadata}
        onError={onError}
      />,
    );
    await settle();

    view.unmount();
    await settle();
    expect(harness.closeCalls).toBe(1);
    probe.resolve({ kind: 'audio', durationMs: 20_000, coverArt: null, title: null });
    open.reject(new Error('open failed after unmount'));
    await settle();

    expect(onLoadedMetadata).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('Audio', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows controls by default and hides them only when controls is false', async () => {
    const harness = createFakeAudio();
    mockSuccessfulLoad(harness, 20_000);
    const shown = render(<Audio src="song.mp3" />);
    await flush();
    expect(shown.lastFrame()).toContain(PAUSE_GLYPH);
    expect(shown.lastFrame()).toContain('0:00 / 0:20');
    shown.unmount();

    const hidden = render(<Audio src="song.mp3" controls={false} />);
    await flush();
    expect(hidden.lastFrame()).toBe('');
    hidden.unmount();
  });

  it('exposes HTML-shaped transport and metadata through AudioRef', async () => {
    const harness = createFakeAudio();
    mockSuccessfulLoad(harness, 20_000);
    const ref = createRef<AudioRef>();
    const view = render(<Audio ref={ref} src="song.mp3" />);
    await flush();

    expect(ref.current?.duration).toBe(20);
    expect(ref.current?.paused).toBe(true);
    ref.current!.currentTime = 5;
    await ref.current?.play();
    expect(harness.playFroms).toEqual([5_000]);
    ref.current!.muted = true;
    await flush();
    expect(harness.mutedValues.at(-1)).toBe(true);
    expect(ref.current?.muted).toBe(true);
    view.unmount();
  });

  it('exposes current ref state inside transport callbacks', async () => {
    const harness = createFakeAudio();
    mockSuccessfulLoad(harness, 1_000);
    const ref = createRef<AudioRef>();
    const snapshots: Array<Pick<AudioRef, 'paused' | 'ended' | 'muted'>> = [];
    const capture = (): void => {
      snapshots.push({
        paused: ref.current!.paused,
        ended: ref.current!.ended,
        muted: ref.current!.muted,
      });
    };
    const view = render(
      <Audio
        ref={ref}
        src="song.mp3"
        onPlay={capture}
        onPause={capture}
        onEnded={capture}
      />,
    );
    await flush();

    ref.current!.muted = true;
    await ref.current!.play();
    ref.current!.pause();
    await ref.current!.play();
    await advance(AUDIO_TICK_MS + 1_000);

    expect(snapshots).toEqual([
      { paused: false, ended: false, muted: true },
      { paused: true, ended: false, muted: true },
      { paused: false, ended: false, muted: true },
      { paused: true, ended: true, muted: true },
      { paused: true, ended: true, muted: true },
    ]);
    view.unmount();
  });

  it('makes metadata available and seekable before autoplay', async () => {
    const harness = createFakeAudio();
    const events: string[] = [];
    harness.audio.playFrom = (timeMs) => {
      harness.playFroms.push(timeMs);
      events.push(`play:${timeMs}`);
    };
    mockSuccessfulLoad(harness, 20_000);
    const ref = createRef<AudioRef>();
    const view = render(
      <Audio
        ref={ref}
        src="song.mp3"
        autoPlay
        onLoadedMetadata={() => {
          events.push(`metadata:${ref.current?.duration}`);
          ref.current!.currentTime = 5;
        }}
      />,
    );
    await flush();

    expect(events).toEqual(['metadata:20', 'play:5000']);
    expect(ref.current?.currentTime).toBe(5);
    view.unmount();
  });

  it('lets metadata pause cancel pending autoplay', async () => {
    const harness = createFakeAudio();
    mockSuccessfulLoad(harness, 20_000);
    const ref = createRef<AudioRef>();
    const view = render(
      <Audio
        ref={ref}
        src="song.mp3"
        autoPlay
        onLoadedMetadata={() => ref.current?.pause()}
      />,
    );
    await flush();

    expect(harness.playFroms).toEqual([]);
    expect(ref.current?.paused).toBe(true);
    view.unmount();
  });

  it('applies a replacement metadata seek before starting the new player', async () => {
    const first = createFakeAudio();
    const second = createFakeAudio();
    mediaProbeMocks.probeMediaFile
      .mockResolvedValueOnce({ kind: 'audio', durationMs: 20_000, coverArt: null, title: null })
      .mockResolvedValueOnce({ kind: 'audio', durationMs: 10_000, coverArt: null, title: null });
    ffmpegAudioMocks.createFfmpegAudioPlayer
      .mockReturnValueOnce(first.audio)
      .mockReturnValueOnce(second.audio);
    const ref = createRef<AudioRef>();
    const view = render(
      <Audio
        ref={ref}
        src="first.mp3"
        autoPlay
        onLoadedMetadata={(event: AudioLoadedMetadataEvent) => {
          if (event.duration === 10) {
            ref.current!.currentTime = 5;
          }
        }}
      />,
    );
    await flush();
    expect(first.playFroms).toEqual([0]);

    view.rerender(
      <Audio
        ref={ref}
        src="second.mp3"
        autoPlay
        onLoadedMetadata={(event: AudioLoadedMetadataEvent) => {
          if (event.duration === 10) {
            ref.current!.currentTime = 5;
          }
        }}
      />,
    );
    await flush();

    expect(second.playFroms).toEqual([5_000]);
    expect(ref.current?.paused).toBe(false);
    view.unmount();
  });

  it('lets replacement metadata pause prevent the new player from starting', async () => {
    const first = createFakeAudio();
    const second = createFakeAudio();
    mediaProbeMocks.probeMediaFile
      .mockResolvedValueOnce({ kind: 'audio', durationMs: 20_000, coverArt: null, title: null })
      .mockResolvedValueOnce({ kind: 'audio', durationMs: 10_000, coverArt: null, title: null });
    ffmpegAudioMocks.createFfmpegAudioPlayer
      .mockReturnValueOnce(first.audio)
      .mockReturnValueOnce(second.audio);
    const ref = createRef<AudioRef>();
    const onLoadedMetadata = (event: AudioLoadedMetadataEvent): void => {
      if (event.duration === 10) {
        ref.current?.pause();
      }
    };
    const view = render(
      <Audio
        ref={ref}
        src="first.mp3"
        autoPlay
        onLoadedMetadata={onLoadedMetadata}
      />,
    );
    await flush();
    expect(first.playFroms).toEqual([0]);

    view.rerender(
      <Audio
        ref={ref}
        src="second.mp3"
        autoPlay
        onLoadedMetadata={onLoadedMetadata}
      />,
    );
    await flush();

    expect(second.playFroms).toEqual([]);
    expect(ref.current?.paused).toBe(true);
    view.unmount();
  });

  it('delays loading and buffering indicators and hides them without controls', async () => {
    const pending = createDeferred<{
      kind: 'audio';
      durationMs: number;
      coverArt: null;
      title: null;
    }>();
    const harness = createFakeAudio();
    mediaProbeMocks.probeMediaFile.mockReturnValue(pending.promise);
    ffmpegAudioMocks.createFfmpegAudioPlayer.mockReturnValue(harness.audio);
    const loading = render(<Audio src="song.mp3" />);
    await advance(LOADING_DELAY_MS - 1);
    expect(loading.lastFrame()).not.toContain(LOADING_TEXT);
    await advance(1);
    expect(loading.lastFrame()).toContain(LOADING_TEXT);
    loading.unmount();

    const hidden = render(<Audio src="song.mp3" controls={false} />);
    await advance(LOADING_DELAY_MS);
    expect(hidden.lastFrame()).toBe('');
    hidden.unmount();

    harness.starting = true;
    mockSuccessfulLoad(harness, 20_000);
    const buffering = render(<Audio src="song.mp3" autoPlay />);
    await flush();
    await advance(LOADING_DELAY_MS - 1);
    expect(buffering.lastFrame()).not.toContain(BUFFERING_TEXT);
    await advance(1);
    expect(buffering.lastFrame()).toContain(BUFFERING_TEXT);
    buffering.unmount();
  });

  it('uses width for the progress bar and centers the row within height', async () => {
    const harness = createFakeAudio();
    mockSuccessfulLoad(harness, 20_000);
    const natural = render(<Audio src="song.mp3" />);
    const sized = render(<Audio src="song.mp3" width={20} />);
    const narrow = render(<Audio src="song.mp3" width={5} />);
    const tall = render(<Audio src="song.mp3" height={3} />);
    await flush();

    expect(natural.lastFrame()).toHaveLength(47);
    expect(sized.lastFrame()).toHaveLength(20);
    expect(narrow.lastFrame()).toHaveLength(15);
    expect(tall.lastFrame()?.split('\n')).toEqual(['', natural.lastFrame(), '']);
    natural.unmount();
    sized.unmount();
    narrow.unmount();
    tall.unmount();
  });

  it('keeps buffering output within the effective narrow width', async () => {
    const harness = createFakeAudio();
    harness.starting = true;
    mockSuccessfulLoad(harness, 20_000);
    const view = render(<Audio src="song.mp3" autoPlay width={5} />);
    await flush();
    await advance(LOADING_DELAY_MS);

    expect(view.lastFrame()?.split('\n')).toHaveLength(1);
    expect(view.lastFrame()).toHaveLength(15);
    view.unmount();
  });

  it('handles transport keys only when keyboard is enabled', async () => {
    const enabledAudio = createFakeAudio();
    mockSuccessfulLoad(enabledAudio, 20_000);
    const enabled = render(<Audio src="song.mp3" keyboard />);
    await flush();
    enabled.stdin.write(' ');
    enabled.stdin.write('\u001B[C');
    enabled.stdin.write('\u001B[D');
    enabled.stdin.write('m');
    await flush();
    expect(enabledAudio.playFroms).toEqual([0, 5_000, 0]);
    expect(enabledAudio.mutedValues.at(-1)).toBe(true);
    enabled.unmount();

    const disabledAudio = createFakeAudio();
    mockSuccessfulLoad(disabledAudio, 20_000);
    const disabled = render(<Audio src="song.mp3" />);
    await flush();
    disabled.stdin.write(' ');
    disabled.stdin.write('\u001B[C');
    disabled.stdin.write('m');
    disabled.stdin.write('q');
    await flush();
    expect(disabledAudio.playFroms).toEqual([]);
    expect(disabledAudio.mutedValues).toEqual([false]);
    expect(appMocks.exit).not.toHaveBeenCalled();
    disabled.unmount();
  });

  it.each(['q', '\u0003'])('requests close before exiting for %j', async (input) => {
    const calls: string[] = [];
    const harness = createFakeAudio();
    harness.audio.close = () => {
      calls.push('close');
      return Promise.resolve();
    };
    appMocks.exit.mockImplementation(() => calls.push('exit'));
    mockSuccessfulLoad(harness, 20_000);
    const view = render(<Audio src="song.mp3" keyboard />);
    await flush();
    view.stdin.write(input);
    await flush();
    expect(calls).toEqual(['close', 'exit']);
    view.unmount();
  });

  it('renders children after errors even without controls and otherwise renders nothing', async () => {
    mediaProbeMocks.probeMediaFile.mockRejectedValue(new Error('failed'));
    ffmpegAudioMocks.createFfmpegAudioPlayer.mockReturnValue(createFakeAudio().audio);
    const fallback = render(
      <Audio src="song.mp3" controls={false}>
        <Text>audio unavailable</Text>
      </Audio>,
    );
    const empty = render(<Audio src="song.mp3" controls={false} />);
    await flush();
    expect(fallback.lastFrame()).toBe('audio unavailable');
    expect(empty.lastFrame()).toBe('');
    fallback.unmount();
    empty.unmount();
  });

  it('applies prop muting and reports metadata and time callbacks in seconds', async () => {
    const harness = createFakeAudio();
    const onLoadedMetadata = vi.fn();
    const onTimeUpdate = vi.fn();
    mockSuccessfulLoad(harness, 20_000);
    const view = render(
      <Audio
        src="song.mp3"
        muted
        autoPlay
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
      />,
    );
    await flush();
    expect(harness.mutedValues.at(-1)).toBe(true);
    expect(onLoadedMetadata).toHaveBeenCalledWith({ duration: 20 });
    await advance(AUDIO_TICK_MS + 1_000);
    expect(onTimeUpdate).toHaveBeenCalledWith({ currentTime: 1, duration: 20 });
    view.unmount();
  });

  it('synchronizes muted prop changes after mount', async () => {
    const harness = createFakeAudio();
    mockSuccessfulLoad(harness, 20_000);
    const ref = createRef<AudioRef>();
    const view = render(<Audio ref={ref} src="song.mp3" muted={false} />);
    await flush();
    expect(ref.current?.muted).toBe(false);

    view.rerender(<Audio ref={ref} src="song.mp3" muted />);
    await flush();
    expect(harness.mutedValues.at(-1)).toBe(true);
    expect(ref.current?.muted).toBe(true);
    view.unmount();
  });

  it('reports NaN before load and resets metadata and playhead when src changes', async () => {
    const first = createFakeAudio();
    const second = createFakeAudio();
    const secondProbe = createDeferred<{
      kind: 'audio';
      durationMs: number;
      coverArt: null;
      title: null;
    }>();
    mediaProbeMocks.probeMediaFile
      .mockResolvedValueOnce({ kind: 'audio', durationMs: 20_000, coverArt: null, title: null })
      .mockReturnValueOnce(secondProbe.promise);
    ffmpegAudioMocks.createFfmpegAudioPlayer
      .mockReturnValueOnce(first.audio)
      .mockReturnValueOnce(second.audio);
    const ref = createRef<AudioRef>();
    const view = render(<Audio ref={ref} src="first.mp3" />);
    expect(ref.current?.duration).toBe(Number.NaN);
    await flush();
    ref.current!.currentTime = 5;
    expect(ref.current?.currentTime).toBe(5);

    view.rerender(<Audio ref={ref} src="second.mp3" />);
    await flush();
    expect(ref.current?.duration).toBe(Number.NaN);
    expect(ref.current?.currentTime).toBe(0);
    secondProbe.resolve({ kind: 'audio', durationMs: 10_000, coverArt: null, title: null });
    await flush();
    expect(ref.current?.duration).toBe(10);
    view.unmount();
  });
});

describe('useAudioPlaybackClock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts autoplay at zero and holds while audio is starting', async () => {
    const harness = createFakeAudio();
    harness.starting = true;
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness ref={clock} audio={harness.audio} durationMs={20_000} autoPlay loop={false} />,
    );

    await flush();
    expect(harness.playFroms).toEqual([0]);
    expect(clock.current?.buffering).toBe(true);

    await advance(500);
    expect(clock.current?.getElapsedMs()).toBe(0);

    harness.starting = false;
    await advance(AUDIO_TICK_MS);
    expect(clock.current?.buffering).toBe(false);
    view.unmount();
  });

  it('seeks without starting while paused and restarts while playing', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={20_000}
        autoPlay={false}
        loop={false}
      />,
    );
    await flush();

    clock.current?.seekToMs(5_000);
    expect(clock.current?.getElapsedMs()).toBe(5_000);
    expect(harness.playFroms).toEqual([]);

    clock.current?.play();
    expect(harness.playFroms).toEqual([5_000]);
    clock.current?.seekToMs(10_000);
    expect(harness.playFroms).toEqual([5_000, 10_000]);
    view.unmount();
  });

  it('pauses the player and reports pause once', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const onPause = vi.fn();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={20_000}
        autoPlay
        loop={false}
        onPause={onPause}
      />,
    );
    await flush();

    clock.current?.pause();
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(harness.pauseCalls).toBe(1);
    expect(clock.current?.playing).toBe(false);
    view.unmount();
  });

  it('parks at the end and calls onPause before onEnded', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const events: string[] = [];
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={100}
        autoPlay
        loop={false}
        onPause={() => events.push('pause')}
        onEnded={() => events.push('ended')}
      />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 100);
    expect(clock.current?.getElapsedMs()).toBe(100);
    expect(clock.current?.playing).toBe(false);
    expect(clock.current?.ended).toBe(true);
    expect(events).toEqual(['pause', 'ended']);
    expect(harness.pauseCalls).toBe(1);
    view.unmount();
  });

  it('replays from zero after reaching the end', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness ref={clock} audio={harness.audio} durationMs={100} autoPlay loop={false} />,
    );
    await flush();
    await advance(AUDIO_TICK_MS + 100);

    clock.current?.play();
    expect(clock.current?.getElapsedMs()).toBe(0);
    expect(clock.current?.ended).toBe(false);
    expect(harness.playFroms.at(-1)).toBe(0);
    view.unmount();
  });

  it('loops through the start gate without calling onEnded', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const onEnded = vi.fn();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={100}
        autoPlay
        loop
        onEnded={onEnded}
      />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 100);
    expect(onEnded).not.toHaveBeenCalled();
    expect(clock.current?.playing).toBe(true);
    expect(harness.playFroms).toEqual([0, 0]);
    view.unmount();
  });

  it('clamps seeks and pauses the player while paused', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={20_000}
        autoPlay={false}
        loop={false}
      />,
    );
    await flush();

    clock.current?.seekToMs(-1_000);
    expect(clock.current?.getElapsedMs()).toBe(0);
    clock.current?.seekToMs(30_000);
    expect(clock.current?.getElapsedMs()).toBe(20_000);
    expect(harness.pauseCalls).toBe(2);
    view.unmount();
  });

  it('reports each whole-second crossing in seconds', async () => {
    const harness = createFakeAudio();
    const onTimeUpdate = vi.fn();
    const view = render(
      <ClockHarness
        audio={harness.audio}
        durationMs={20_000}
        autoPlay
        loop={false}
        onTimeUpdate={onTimeUpdate}
      />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 1_000);
    expect(onTimeUpdate).toHaveBeenCalledWith({ currentTime: 1, duration: 20 });
    view.unmount();
  });

  it('restarts at the playhead when drift exceeds the threshold', async () => {
    const harness = createFakeAudio();
    harness.positionMs = 1_000 + DRIFT_RESYNC_THRESHOLD_MS + 1;
    const view = render(
      <ClockHarness audio={harness.audio} durationMs={20_000} autoPlay loop={false} />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 1_000);
    expect(harness.playFroms).toEqual([0, 1_000]);
    view.unmount();
  });

  it('does not restart for drift when onTimeUpdate pauses playback', async () => {
    const harness = createFakeAudio();
    harness.positionMs = 1_000 + DRIFT_RESYNC_THRESHOLD_MS + 1;
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={20_000}
        autoPlay
        loop={false}
        onTimeUpdate={() => clock.current?.pause()}
      />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 1_000);
    expect(clock.current?.playing).toBe(false);
    expect(clock.current?.buffering).toBe(false);
    expect(harness.playFroms).toEqual([0]);
    expect(harness.pauseCalls).toBe(1);
    view.unmount();
  });

  it('skips drift correction when the player has no position', async () => {
    const harness = createFakeAudio();
    harness.positionMs = null;
    const view = render(
      <ClockHarness audio={harness.audio} durationMs={20_000} autoPlay loop={false} />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 1_000);
    expect(harness.playFroms).toEqual([0]);
    view.unmount();
  });

  it('honors play and pause callback re-entry', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={20_000}
        autoPlay={false}
        loop={false}
        onPlay={() => clock.current?.pause()}
        onPause={() => {
          if (harness.playFroms.length > 0) {
            clock.current?.play();
          }
        }}
      />,
    );
    await flush();

    clock.current?.play();
    expect(harness.playFroms).toEqual([]);
    expect(harness.pauseCalls).toBe(1);

    view.rerender(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={20_000}
        autoPlay={false}
        loop={false}
        onPause={() => clock.current?.play()}
      />,
    );
    clock.current?.play();
    clock.current?.pause();
    expect(harness.playFroms).toEqual([0, 0]);
    expect(harness.pauseCalls).toBe(1);
    view.unmount();
  });

  it('lets an onEnded callback replay without pausing the restarted player', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={100}
        autoPlay
        loop={false}
        onEnded={() => clock.current?.play()}
      />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 100);
    expect(harness.playFroms).toEqual([0, 0]);
    expect(harness.pauseCalls).toBe(0);
    expect(clock.current?.playing).toBe(true);
    view.unmount();
  });

  it('does not restart a loop when its onTimeUpdate pauses playback', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={1_100}
        autoPlay
        loop
        onTimeUpdate={(event) => {
          if (event.currentTime === 0) {
            clock.current?.pause();
          }
        }}
      />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 1_100);
    expect(clock.current?.playing).toBe(false);
    expect(clock.current?.buffering).toBe(false);
    expect(harness.playFroms).toEqual([0]);
    expect(harness.pauseCalls).toBe(1);
    view.unmount();
  });

  it('keeps an onTimeUpdate seek made while looping', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={1_100}
        autoPlay
        loop
        onTimeUpdate={(event) => {
          if (event.currentTime === 0) {
            clock.current?.seekToMs(500);
          }
        }}
      />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 1_100);
    expect(clock.current?.getElapsedMs()).toBe(500);
    expect(harness.playFroms).toEqual([0, 500]);
    view.unmount();
  });

  it('keeps an onTimeUpdate seek made at the end', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const onEnded = vi.fn();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={1_000}
        autoPlay
        loop={false}
        onTimeUpdate={(event) => {
          if (event.currentTime === 1) {
            clock.current?.seekToMs(500);
          }
        }}
        onEnded={onEnded}
      />,
    );
    await flush();

    await advance(AUDIO_TICK_MS + 1_000);
    expect(clock.current?.getElapsedMs()).toBe(500);
    expect(clock.current?.playing).toBe(true);
    expect(clock.current?.ended).toBe(false);
    expect(harness.playFroms).toEqual([0, 500]);
    expect(onEnded).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps a nested onTimeUpdate seek made during a direct seek', async () => {
    const harness = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness
        ref={clock}
        audio={harness.audio}
        durationMs={20_000}
        autoPlay
        loop={false}
        onTimeUpdate={(event) => {
          if (event.currentTime === 1) {
            clock.current?.seekToMs(500);
          }
        }}
      />,
    );
    await flush();

    clock.current?.seekToMs(1_000);
    expect(clock.current?.getElapsedMs()).toBe(500);
    expect(harness.playFroms).toEqual([0, 500]);
    view.unmount();
  });

  it('pauses the old player and resets autoplay when the player is replaced', async () => {
    const first = createFakeAudio();
    const second = createFakeAudio();
    const clock = createRef<AudioPlaybackClock>();
    const view = render(
      <ClockHarness ref={clock} audio={first.audio} durationMs={20_000} autoPlay loop={false} />,
    );
    await flush();
    clock.current?.seekToMs(5_000);

    view.rerender(
      <ClockHarness ref={clock} audio={second.audio} durationMs={10_000} autoPlay loop={false} />,
    );
    await flush();
    expect(first.pauseCalls).toBe(1);
    expect(clock.current?.getElapsedMs()).toBe(0);
    expect(second.playFroms).toEqual([0]);
    view.unmount();
  });

  it('pauses the current player during cleanup', async () => {
    const harness = createFakeAudio();
    const view = render(
      <ClockHarness
        audio={harness.audio}
        durationMs={20_000}
        autoPlay={false}
        loop={false}
      />,
    );
    await flush();

    view.unmount();
    await flush();
    expect(harness.pauseCalls).toBe(1);
  });

  it('pauses a player during cleanup before metadata arrives', async () => {
    const harness = createFakeAudio();
    const view = render(
      <ClockHarness audio={harness.audio} durationMs={null} autoPlay loop={false} />,
    );
    await flush();

    view.unmount();
    await flush();
    expect(harness.pauseCalls).toBe(1);
  });
});
