import { isRecord } from '../isRecord/index.ts';
import { FRAME_PACING_INTERVAL_MS, MS_PER_SECOND, RTAUDIO_FORMAT_SINT16 } from './consts.ts';
import type { CreateAudioDevice, RtAudioStream } from './types.ts';

/** True when value quacks like the RtAudio instance the adapter drives */
const isRtAudioStream = (value: unknown): value is RtAudioStream =>
  isRecord(value) &&
  typeof value.outputVolume === 'number' &&
  typeof value.openStream === 'function' &&
  typeof value.getDefaultOutputDevice === 'function' &&
  typeof value.start === 'function' &&
  typeof value.stop === 'function' &&
  typeof value.closeStream === 'function' &&
  typeof value.write === 'function' &&
  typeof value.clearOutputQueue === 'function';

/**
 * Production AudioDevice factory over audify's RtAudio. The import is
 * dynamic and everything runs inside one try/catch, so a platform without a
 * working prebuild, or a machine without any output device, resolves null
 * and the player degrades to silent video instead of crashing. audify is
 * CJS built from an object spread, so RtAudio is only reliably reachable
 * through the default interop export.
 */
export const createRtAudioDevice: CreateAudioDevice = async ({
  sampleRate,
  channels,
  frameSize,
  onFrameDone,
}) => {
  try {
    const imported: unknown = await import('audify');
    const moduleRecord =
      isRecord(imported) && isRecord(imported.default) ? imported.default : imported;
    if (!isRecord(moduleRecord) || typeof moduleRecord.RtAudio !== 'function') {
      return null;
    }
    const instance: unknown = Reflect.construct(moduleRecord.RtAudio, []);
    if (!isRtAudioStream(instance)) {
      return null;
    }
    const actualFrameSize = instance.openStream(
      { deviceId: instance.getDefaultOutputDevice(), nChannels: channels },
      null,
      RTAUDIO_FORMAT_SINT16,
      sampleRate,
      frameSize,
      'kitty-media-player',
      null,
      // NEVER pass onFrameDone here: audify's frameOutputCallback registers
      // a native thread-safe function that is released neither by
      // closeStream() nor by setFrameOutputCallback(null), so the process
      // can never exit again once a stream was opened with one. The pacing
      // timer below emulates the callback instead.
      null,
    );
    instance.start();
    const effectiveFrameSize = actualFrameSize > 0 ? actualFrameSize : frameSize;
    const frameDurationMs = (effectiveFrameSize / sampleRate) * MS_PER_SECOND;

    // Wall-clock emulation of RtAudio's per-frame playback callback. The
    // device consumes one frame per frameDurationMs while its queue is
    // non-empty, so onFrameDone fires paced from the moment the current
    // backlog started playing, clamped to what was actually written. The
    // timer is unref'd so it never keeps the process alive on its own.
    let framesWritten = 0;
    let framesDone = 0;
    let playbackBaseMs = 0;
    let framesDoneAtBase = 0;
    const pacingTimer = setInterval(() => {
      if (framesDone >= framesWritten) {
        return;
      }
      const playedSinceBase = Math.floor((Date.now() - playbackBaseMs) / frameDurationMs);
      const target = Math.min(framesWritten, framesDoneAtBase + playedSinceBase);
      while (framesDone < target) {
        framesDone += 1;
        onFrameDone();
      }
    }, FRAME_PACING_INTERVAL_MS);
    pacingTimer.unref();

    return {
      frameSize: effectiveFrameSize,
      write: (pcm) => {
        if (framesWritten === framesDone) {
          // The queue was empty, this write starts a fresh playback run
          playbackBaseMs = Date.now();
          framesDoneAtBase = framesDone;
        }
        framesWritten += 1;
        instance.write(pcm);
      },
      clearQueue: () => {
        instance.clearOutputQueue();
        // Dropped frames never finish playing, so they leave the pacing too
        framesWritten = framesDone;
      },
      setVolume: (volume) => {
        instance.outputVolume = volume;
      },
      close: () => {
        clearInterval(pacingTimer);
        try {
          instance.stop();
          instance.closeStream();
        } catch {
          // The device backend may already be gone during teardown
        }
      },
    };
  } catch {
    return null;
  }
};
