import { useEffect, useRef, useState } from 'react';

import { createFfmpegAudioPlayer } from '../ffmpegAudioPlayer/index.ts';
import { probeMediaFile } from '../mediaProbe/index.ts';
import { INITIAL_MANAGED_AUDIO_RESOURCES, MS_PER_SECOND } from './consts.ts';
import type { ManagedAudioResources, ManagedAudioResourcesOptions } from './types.ts';
import { AudioError } from './types.ts';

export const useManagedResources = ({
  src,
  onLoadedMetadata,
  onError,
}: ManagedAudioResourcesOptions): ManagedAudioResources => {
  const [resources, setResources] = useState<ManagedAudioResources>(
    INITIAL_MANAGED_AUDIO_RESOURCES,
  );
  const callbacksRef = useRef({ onLoadedMetadata, onError });
  callbacksRef.current = { onLoadedMetadata, onError };

  useEffect(() => {
    const openingProbe = probeMediaFile(src);
    const hasAudio = async (): Promise<boolean> => {
      const probe = await openingProbe;
      return probe.kind === 'audio' || probe.hasAudio;
    };
    const audio = createFfmpegAudioPlayer({ filePath: src, probeAudio: hasAudio });
    let cancelled = false;
    setResources(INITIAL_MANAGED_AUDIO_RESOURCES);

    void Promise.all([openingProbe, audio.open()])
      .then(([probe, info]) => {
        if (cancelled) {
          return;
        }
        const streamPresent = probe.kind === 'audio' || probe.hasAudio;
        if (!streamPresent) {
          throw new AudioError('NO_AUDIO_STREAM');
        }
        if (!info.hasAudio) {
          throw new AudioError('AUDIO_UNAVAILABLE');
        }
        setResources({ status: 'ready', audio, durationMs: probe.durationMs });
        callbacksRef.current.onLoadedMetadata?.({
          duration: probe.durationMs / MS_PER_SECOND,
        });
      })
      .catch((error: unknown) => {
        void audio.close().catch(() => undefined);
        if (!cancelled) {
          setResources({ status: 'error', audio: null, durationMs: null });
          callbacksRef.current.onError?.(error);
        }
      });

    return () => {
      cancelled = true;
      setResources(INITIAL_MANAGED_AUDIO_RESOURCES);
      void audio.close().catch(() => undefined);
    };
  }, [src]);

  return resources;
};
