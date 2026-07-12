import { isRecord } from '../isRecord/index.ts';
import { RTAUDIO_FORMAT_SINT16 } from './consts.ts';
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
      'kitty-video-player',
      null,
      onFrameDone,
    );
    instance.start();
    return {
      frameSize: actualFrameSize > 0 ? actualFrameSize : frameSize,
      write: (pcm) => {
        instance.write(pcm);
      },
      clearQueue: () => {
        instance.clearOutputQueue();
      },
      setVolume: (volume) => {
        instance.outputVolume = volume;
      },
      close: () => {
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
