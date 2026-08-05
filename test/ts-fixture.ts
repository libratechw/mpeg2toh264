const PACKET_SIZE = 188;

function psiPacket(pid: number, section: readonly number[]): Uint8Array {
  const packet = new Uint8Array(PACKET_SIZE).fill(0xff);
  packet.set([0x47, 0x40 | (pid >> 8), pid & 0xff, 0x10, 0x00]);
  packet.set(section, 5);
  return packet;
}

export function wrapMpeg2EsInTs(es: Uint8Array): Uint8Array {
  const pat = psiPacket(
    0,
    [
      0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00, 0,
      0, 0, 0,
    ],
  );
  const pmt = psiPacket(
    0x100,
    [
      0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00,
      0x02, 0xe1, 0x01, 0xf0, 0x00, 0, 0, 0, 0,
    ],
  );
  const pes = new Uint8Array(9 + es.length);
  pes.set([0, 0, 1, 0xe0, 0, 0, 0x80, 0, 0]);
  pes.set(es, 9);

  const packets: Uint8Array[] = [pat, pmt];
  let at = 0;
  let continuity = 0;
  while (at < pes.length) {
    const size = Math.min(184, pes.length - at);
    const packet = new Uint8Array(PACKET_SIZE).fill(0xff);
    const start = at === 0 ? 0x40 : 0;
    if (size === 184) {
      packet.set([0x47, start | 0x01, 0x01, 0x10 | continuity]);
      packet.set(pes.subarray(at, at + size), 4);
    } else {
      const adaptationLength = 183 - size;
      packet.set([
        0x47,
        start | 0x01,
        0x01,
        0x30 | continuity,
        adaptationLength,
      ]);
      if (adaptationLength > 0) packet[5] = 0;
      packet.set(pes.subarray(at, at + size), 5 + adaptationLength);
    }
    packets.push(packet);
    continuity = (continuity + 1) & 15;
    at += size;
  }

  const out = new Uint8Array(packets.length * PACKET_SIZE);
  for (let i = 0; i < packets.length; i++)
    out.set(packets[i]!, i * PACKET_SIZE);
  return out;
}
