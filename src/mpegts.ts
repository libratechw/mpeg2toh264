/** Minimal MPEG-TS demuxing for an MPEG-2 video elementary stream. */

const TS_PACKET_SIZE = 188;
const SYNC_BYTE = 0x47;
const STREAM_TYPE_MPEG2_VIDEO = 0x02;
const STREAM_TYPE_AAC_ADTS = 0x0f;

interface TsPayload {
  pid: number;
  payloadUnitStart: boolean;
  data: Uint8Array;
}

function syncOffset(data: Uint8Array): number {
  for (
    let offset = 0;
    offset < Math.min(TS_PACKET_SIZE, data.length);
    offset++
  ) {
    if (data[offset] !== SYNC_BYTE) continue;
    let matches = 0;
    for (
      let at = offset;
      at < data.length && matches < 4;
      at += TS_PACKET_SIZE
    ) {
      if (data[at] !== SYNC_BYTE) break;
      matches++;
    }
    if (
      matches >=
      Math.min(4, Math.floor((data.length - offset) / TS_PACKET_SIZE))
    ) {
      return offset;
    }
  }
  return -1;
}

export function isMpegTransportStream(data: Uint8Array): boolean {
  return data.length >= TS_PACKET_SIZE && syncOffset(data) >= 0;
}

function payloadAt(data: Uint8Array, at: number): TsPayload | null {
  if (data[at] !== SYNC_BYTE)
    throw new Error(`MPEG-TS sync lost at byte ${at}`);
  if (data[at + 1]! & 0x80)
    throw new Error(`MPEG-TS transport error at byte ${at}`);
  const payloadUnitStart = (data[at + 1]! & 0x40) !== 0;
  const pid = ((data[at + 1]! & 0x1f) << 8) | data[at + 2]!;
  const adaptationControl = (data[at + 3]! >> 4) & 3;
  if (adaptationControl === 0)
    throw new Error(`invalid adaptation_field_control at byte ${at}`);
  if ((adaptationControl & 1) === 0) return null;
  let payload = at + 4;
  if (adaptationControl & 2) payload += 1 + data[payload]!;
  const end = at + TS_PACKET_SIZE;
  if (payload > end)
    throw new Error(`invalid MPEG-TS adaptation field at byte ${at}`);
  return { pid, payloadUnitStart, data: data.subarray(payload, end) };
}

class SectionAssembler {
  private bytes: number[] = [];

  push(
    payload: Uint8Array,
    payloadUnitStart: boolean,
    emit: (section: Uint8Array) => void,
  ) {
    let at = 0;
    if (payloadUnitStart) {
      if (payload.length === 0) return;
      const pointer = payload[0]!;
      at = 1;
      if (this.bytes.length > 0 && pointer > 0) {
        this.append(payload.subarray(at, at + pointer), emit);
      }
      this.bytes = [];
      at += pointer;
    }
    this.append(payload.subarray(at), emit);
  }

  private append(data: Uint8Array, emit: (section: Uint8Array) => void) {
    for (const byte of data) this.bytes.push(byte);
    for (;;) {
      if (this.bytes[0] === 0xff) {
        this.bytes = [];
        return;
      }
      if (this.bytes.length < 3) return;
      const length = 3 + (((this.bytes[1]! & 0x0f) << 8) | this.bytes[2]!);
      if (this.bytes.length < length) return;
      emit(Uint8Array.from(this.bytes.splice(0, length)));
    }
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function pesPayload(
  packet: Uint8Array,
  kind: "video" | "audio" = "video",
): Uint8Array {
  if (
    packet.length < 9 ||
    packet[0] !== 0 ||
    packet[1] !== 0 ||
    packet[2] !== 1
  ) {
    throw new Error(`invalid MPEG-TS ${kind} PES start code`);
  }
  const streamId = packet[3]!;
  const validStreamId =
    kind === "video"
      ? streamId >= 0xe0 && streamId <= 0xef
      : streamId >= 0xc0 && streamId <= 0xdf;
  if (!validStreamId)
    throw new Error(`unexpected ${kind} stream_id 0x${streamId.toString(16)}`);
  const pesLength = (packet[4]! << 8) | packet[5]!;
  let start: number;
  if ((packet[6]! & 0xc0) === 0x80) {
    start = 9 + packet[8]!;
  } else {
    // MPEG-1 PES header form, retained for older transport streams.
    start = 6;
    while (packet[start] === 0xff) start++;
    if ((packet[start]! & 0xc0) === 0x40) start += 2;
    const marker = packet[start]! & 0xf0;
    if (marker === 0x20) start += 5;
    else if (marker === 0x30) start += 10;
    else if (packet[start] === 0x0f) start++;
    else throw new Error("invalid MPEG-1 PES header");
  }
  const end =
    pesLength === 0 ? packet.length : Math.min(packet.length, 6 + pesLength);
  if (start > end) throw new Error("truncated MPEG-TS video PES header");
  return packet.subarray(start, end);
}

function isPesStart(packet: Uint8Array, kind: "video" | "audio"): boolean {
  if (
    packet.length < 4 ||
    packet[0] !== 0 ||
    packet[1] !== 0 ||
    packet[2] !== 1
  )
    return false;
  const streamId = packet[3]!;
  return kind === "video"
    ? streamId >= 0xe0 && streamId <= 0xef
    : streamId >= 0xc0 && streamId <= 0xdf;
}

/** Extract the first ISO/IEC 13818-2 video stream advertised by PAT/PMT. */
export function extractMpeg2VideoEs(data: Uint8Array): Uint8Array {
  const firstPacket = syncOffset(data);
  if (firstPacket < 0)
    throw new Error("input is not a 188-byte MPEG transport stream");

  const pmtPids = new Set<number>();
  let videoPid = -1;
  const assemblers = new Map<number, SectionAssembler>();
  assemblers.set(0, new SectionAssembler());

  for (
    let at = firstPacket;
    at + TS_PACKET_SIZE <= data.length;
    at += TS_PACKET_SIZE
  ) {
    const packet = payloadAt(data, at);
    if (!packet || (packet.pid !== 0 && !pmtPids.has(packet.pid))) continue;
    let assembler = assemblers.get(packet.pid);
    if (!assembler) {
      assembler = new SectionAssembler();
      assemblers.set(packet.pid, assembler);
    }
    assembler.push(packet.data, packet.payloadUnitStart, (section) => {
      if (packet.pid === 0 && section[0] === 0x00) {
        const end = section.length - 4;
        for (let i = 8; i + 3 < end; i += 4) {
          const program = (section[i]! << 8) | section[i + 1]!;
          if (program !== 0)
            pmtPids.add(((section[i + 2]! & 0x1f) << 8) | section[i + 3]!);
        }
      } else if (section[0] === 0x02) {
        const programInfoLength = ((section[10]! & 0x0f) << 8) | section[11]!;
        const end = section.length - 4;
        for (let i = 12 + programInfoLength; i + 4 < end;) {
          const streamType = section[i]!;
          const pid = ((section[i + 1]! & 0x1f) << 8) | section[i + 2]!;
          const infoLength = ((section[i + 3]! & 0x0f) << 8) | section[i + 4]!;
          if (videoPid < 0 && streamType === STREAM_TYPE_MPEG2_VIDEO)
            videoPid = pid;
          i += 5 + infoLength;
        }
      }
    });
  }
  if (pmtPids.size === 0) throw new Error("MPEG-TS PAT contains no program");
  if (videoPid < 0)
    throw new Error(
      "MPEG-TS contains no MPEG-2 video stream (stream_type 0x02)",
    );

  const elementaryParts: Uint8Array[] = [];
  let pesParts: Uint8Array[] = [];
  const flushPes = () => {
    if (pesParts.length === 0) return;
    elementaryParts.push(pesPayload(concat(pesParts)));
    pesParts = [];
  };
  for (
    let at = firstPacket;
    at + TS_PACKET_SIZE <= data.length;
    at += TS_PACKET_SIZE
  ) {
    const packet = payloadAt(data, at);
    if (!packet || packet.pid !== videoPid) continue;
    if (packet.payloadUnitStart) flushPes();
    pesParts.push(packet.data);
  }
  flushPes();
  if (elementaryParts.length === 0)
    throw new Error("MPEG-TS MPEG-2 video PID has no PES packets");
  return concat(elementaryParts);
}

export interface MpegTsElementaryPacket {
  kind: "video" | "audio";
  data: Uint8Array;
}

interface PesState {
  parts: Uint8Array[];
  collecting: boolean;
}

/** Stateful MPEG-2-video/AAC demuxer for bounded-memory browser streaming. */
export class MpegTsAvDemuxer {
  private pending: Uint8Array = new Uint8Array(0);
  private synced = false;
  private readonly pmtPids = new Set<number>();
  private readonly assemblers = new Map<number, SectionAssembler>([
    [0, new SectionAssembler()],
  ]);
  private videoPid = -1;
  private audioPid = -1;
  private readonly video: PesState = { parts: [], collecting: false };
  private readonly audio: PesState = { parts: [], collecting: false };

  get hasAacAudio(): boolean {
    return this.audioPid >= 0;
  }

  push(chunk: Uint8Array): MpegTsElementaryPacket[] {
    const input = concat([this.pending, chunk]);
    let at = 0;
    if (!this.synced) {
      const offset = syncOffset(input);
      if (offset < 0) {
        this.pending = input;
        return [];
      }
      at = offset;
      this.synced = true;
    }
    const output: MpegTsElementaryPacket[] = [];
    for (; at + TS_PACKET_SIZE <= input.length; at += TS_PACKET_SIZE) {
      const packet = payloadAt(input, at);
      if (!packet) continue;
      if (packet.pid === 0 || this.pmtPids.has(packet.pid))
        this.pushPsi(packet);
      const kind =
        packet.pid === this.videoPid
          ? "video"
          : packet.pid === this.audioPid
            ? "audio"
            : null;
      if (!kind) continue;
      const state = kind === "video" ? this.video : this.audio;
      if (packet.payloadUnitStart) {
        this.flushPes(kind, state, output);
        state.collecting = isPesStart(packet.data, kind);
      }
      if (state.collecting) state.parts.push(packet.data);
    }
    this.pending = input.slice(at);
    return output;
  }

  finish(): MpegTsElementaryPacket[] {
    if (!this.synced)
      throw new Error("input is not a 188-byte MPEG transport stream");
    if (this.videoPid < 0)
      throw new Error(
        "MPEG-TS contains no MPEG-2 video stream (stream_type 0x02)",
      );
    const output: MpegTsElementaryPacket[] = [];
    this.flushPes("video", this.video, output);
    this.flushPes("audio", this.audio, output);
    return output;
  }

  private pushPsi(packet: TsPayload) {
    let assembler = this.assemblers.get(packet.pid);
    if (!assembler) {
      assembler = new SectionAssembler();
      this.assemblers.set(packet.pid, assembler);
    }
    assembler.push(packet.data, packet.payloadUnitStart, (section) => {
      if (packet.pid === 0 && section[0] === 0x00) {
        const end = section.length - 4;
        for (let i = 8; i + 3 < end; i += 4) {
          const program = (section[i]! << 8) | section[i + 1]!;
          if (program !== 0)
            this.pmtPids.add(((section[i + 2]! & 0x1f) << 8) | section[i + 3]!);
        }
      } else if (section[0] === 0x02) {
        const info = ((section[10]! & 0x0f) << 8) | section[11]!;
        for (let i = 12 + info, end = section.length - 4; i + 4 < end;) {
          const streamType = section[i]!;
          const pid = ((section[i + 1]! & 0x1f) << 8) | section[i + 2]!;
          const length = ((section[i + 3]! & 0x0f) << 8) | section[i + 4]!;
          if (this.videoPid < 0 && streamType === STREAM_TYPE_MPEG2_VIDEO)
            this.videoPid = pid;
          if (this.audioPid < 0 && streamType === STREAM_TYPE_AAC_ADTS)
            this.audioPid = pid;
          i += 5 + length;
        }
      }
    });
  }

  private flushPes(
    kind: "video" | "audio",
    state: PesState,
    output: MpegTsElementaryPacket[],
  ) {
    if (state.parts.length === 0) return;
    output.push({ kind, data: pesPayload(concat(state.parts), kind) });
    state.parts = [];
    state.collecting = false;
  }
}

/** Video-only compatibility facade over the A/V streaming demuxer. */
export class MpegTsVideoDemuxer {
  private readonly demuxer = new MpegTsAvDemuxer();

  push(chunk: Uint8Array): Uint8Array[] {
    return this.demuxer
      .push(chunk)
      .filter((packet) => packet.kind === "video")
      .map((packet) => packet.data);
  }

  finish(): Uint8Array[] {
    return this.demuxer
      .finish()
      .filter((packet) => packet.kind === "video")
      .map((packet) => packet.data);
  }
}
