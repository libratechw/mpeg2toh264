const SAMPLE_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000,
  12_000, 11_025, 8_000, 7_350,
] as const;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export interface AacConfig {
  audioObjectType: number;
  sampleRate: number;
  samplingFrequencyIndex: number;
  channelCount: number;
  audioSpecificConfig: Uint8Array;
}

export interface AacFrame {
  data: Uint8Array;
  config: AacConfig;
}

/** AAC access units needed through an absolute 90 kHz video decode time. */
export function aacFrameCountThroughVideoTime(
  videoTime: number,
  sampleRate: number,
): number {
  return Math.round((videoTime * sampleRate) / (90_000 * 1024));
}

/** Incrementally remove ADTS headers without touching AAC payload bits. */
export class AdtsStream {
  private pending: Uint8Array = new Uint8Array(0);
  private currentConfig: AacConfig | null = null;

  push(chunk: Uint8Array): AacFrame[] {
    this.pending = concat(this.pending, chunk);
    const output: AacFrame[] = [];
    let at = 0;
    while (at + 7 <= this.pending.length) {
      if (
        this.pending[at] !== 0xff ||
        (this.pending[at + 1]! & 0xf6) !== 0xf0
      ) {
        at++;
        continue;
      }
      const protectionAbsent = this.pending[at + 1]! & 1;
      const audioObjectType = ((this.pending[at + 2]! >> 6) & 3) + 1;
      const samplingFrequencyIndex = (this.pending[at + 2]! >> 2) & 15;
      const sampleRate = SAMPLE_RATES[samplingFrequencyIndex];
      const channelCount =
        ((this.pending[at + 2]! & 1) << 2) | (this.pending[at + 3]! >> 6);
      const frameLength =
        ((this.pending[at + 3]! & 3) << 11) |
        (this.pending[at + 4]! << 3) |
        (this.pending[at + 5]! >> 5);
      const headerLength = protectionAbsent ? 7 : 9;
      const rawBlocks = this.pending[at + 6]! & 3;
      if (audioObjectType !== 2)
        throw new Error(
          `unsupported ADTS audio object type ${audioObjectType}; AAC-LC is required`,
        );
      if (!sampleRate)
        throw new Error(
          `unsupported ADTS sampling_frequency_index ${samplingFrequencyIndex}`,
        );
      if (channelCount === 0)
        throw new Error(
          "ADTS program_config_element channel layout is unsupported",
        );
      if (rawBlocks !== 0)
        throw new Error(
          "ADTS frames with multiple raw data blocks are unsupported",
        );
      if (frameLength < headerLength)
        throw new Error("invalid ADTS frame length");
      if (at + frameLength > this.pending.length) break;
      const audioSpecificConfig = Uint8Array.of(
        (audioObjectType << 3) | (samplingFrequencyIndex >> 1),
        ((samplingFrequencyIndex & 1) << 7) | (channelCount << 3),
      );
      const config: AacConfig = {
        audioObjectType,
        sampleRate,
        samplingFrequencyIndex,
        channelCount,
        audioSpecificConfig,
      };
      if (
        this.currentConfig &&
        (this.currentConfig.sampleRate !== sampleRate ||
          this.currentConfig.channelCount !== channelCount)
      )
        throw new Error("ADTS configuration changed within the stream");
      this.currentConfig = config;
      output.push({
        data: this.pending.slice(at + headerLength, at + frameLength),
        config,
      });
      at += frameLength;
    }
    this.pending = this.pending.slice(at);
    return output;
  }

  finish(): AacFrame[] {
    const output = this.push(new Uint8Array(0));
    if (
      this.pending.length > 0 &&
      !(this.pending.length === 1 && this.pending[0] === 0xff)
    ) {
      throw new Error("truncated ADTS frame");
    }
    this.pending = new Uint8Array(0);
    return output;
  }
}
