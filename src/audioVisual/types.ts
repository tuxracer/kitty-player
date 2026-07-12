import type { CoverArtSourceOptions } from '../coverArtSource/index.ts';
import type { FrameSource, FrameSourceInfo } from '../frameSource/index.ts';
import type { AudioProbeResult } from '../mediaProbe/index.ts';
import type { WaveformSourceOptions } from '../waveformSource/index.ts';

export type AudioVisualMode = 'auto' | 'artwork' | 'waveform' | 'none';
export type AudioVisualProp = boolean | 'artwork' | 'waveform';

export type AudioVisualSelection =
  | { kind: 'none' }
  | { kind: 'placeholder'; label: string }
  | {
      kind: 'source';
      visualKind: 'artwork' | 'waveform';
      source: FrameSource;
      info: FrameSourceInfo;
      label: string;
    };

export interface OpenAudioVisualOptions {
  filePath: string;
  probe: AudioProbeResult;
  mode: AudioVisualMode;
  createArtSource?: (options: CoverArtSourceOptions) => FrameSource;
  createWaveSource?: (options: WaveformSourceOptions) => FrameSource;
}
