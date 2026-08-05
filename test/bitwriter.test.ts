import { describe, expect, it } from "vitest";
import { BitWriter, toNalUnit } from "../src/h264/bitwriter.ts";
import {
  b16x8MbType,
  FIELD_SCAN_8X8,
  toZigzag8x8,
  writePcmMacroblock,
} from "../src/h264/mb.ts";

/** Render everything written so far as a bit string, for comparing with the spec. */
function bits(w: BitWriter): string {
  const n = w.bitLength;
  const bytes = w.bitLength % 8 === 0 ? w.bytes() : rawBytes(w);
  let s = "";
  for (const b of bytes) s += b.toString(2).padStart(8, "0");
  return s.slice(0, n);
}

/** bytes() insists on alignment; tests need the partial byte too. */
function rawBytes(w: BitWriter): Uint8Array {
  const copy = new BitWriter(64);
  // Re-read through the public surface by padding to a byte and trimming.
  const pad = (8 - (w.bitLength % 8)) % 8;
  for (let i = 0; i < pad; i++) w.u(1, 0);
  const b = w.bytes().slice();
  void copy;
  return b;
}

describe("field coefficient scan", () => {
  it("serialises 8x8 raster coefficients in field-scan order", () => {
    const raster = Int32Array.from({ length: 64 }, (_, i) => i + 1);
    const out = new Int32Array(64);

    expect(toZigzag8x8(raster, out, true)).toBe(true);
    expect(Array.from(out)).toEqual(
      FIELD_SCAN_8X8.map((position) => position + 1),
    );
  });
});

describe("Exp-Golomb coding", () => {
  // Canonical codeword table from H.264 clause 9.1.
  const ueCases: [number, string][] = [
    [0, "1"],
    [1, "010"],
    [2, "011"],
    [3, "00100"],
    [4, "00101"],
    [5, "00110"],
    [6, "00111"],
    [7, "0001000"],
    [8, "0001001"],
  ];
  for (const [value, code] of ueCases) {
    it(`ue(${value}) is ${code}`, () => {
      const w = new BitWriter(16);
      w.ue(value);
      expect(bits(w)).toBe(code);
    });
  }

  // se(v) maps 0, 1, -1, 2, -2, ... onto codeNum 0, 1, 2, 3, 4, ...
  const seCases: [number, string][] = [
    [0, "1"],
    [1, "010"],
    [-1, "011"],
    [2, "00100"],
    [-2, "00101"],
    [3, "00110"],
    [-3, "00111"],
  ];
  for (const [value, code] of seCases) {
    it(`se(${value}) is ${code}`, () => {
      const w = new BitWriter(16);
      w.se(value);
      expect(bits(w)).toBe(code);
    });
  }

  it("rejects a negative ue(v)", () => {
    const w = new BitWriter(16);
    expect(() => w.ue(-1)).toThrow();
  });
});

describe("fixed width writing", () => {
  it("packs across byte boundaries most significant bit first", () => {
    const w = new BitWriter(16);
    w.u(3, 0b101);
    w.u(7, 0b0110011);
    w.u(6, 0b111000);
    expect(bits(w)).toBe("101" + "0110011" + "111000");
  });

  it("writes a full 32 bit value", () => {
    const w = new BitWriter(16);
    w.u(32, 0xdeadbeef);
    expect(bits(w)).toBe((0xdeadbeef).toString(2).padStart(32, "0"));
  });

  it("pads to a byte with rbsp_trailing_bits", () => {
    const w = new BitWriter(16);
    w.u(3, 0b101);
    w.rbspTrailingBits();
    expect(w.bitLength).toBe(8);
    expect([...w.bytes()]).toEqual([0b10110000]);
  });
});

describe("NAL unit wrapping", () => {
  it("prefixes a start code and the header byte", () => {
    const nal = toNalUnit(new Uint8Array([0xaa, 0xbb]), 3, 7);
    expect([...nal]).toEqual([0x00, 0x00, 0x00, 0x01, 0x67, 0xaa, 0xbb]);
  });

  it("inserts an emulation prevention byte after two zeros", () => {
    // 00 00 01 in the payload would otherwise imitate a start code.
    const nal = toNalUnit(new Uint8Array([0x00, 0x00, 0x01]), 0, 1);
    expect([...nal.slice(5)]).toEqual([0x00, 0x00, 0x03, 0x01]);
  });

  it("escapes every value that can follow two zeros", () => {
    for (const b of [0x00, 0x01, 0x02, 0x03]) {
      const nal = toNalUnit(new Uint8Array([0x00, 0x00, b]), 0, 1);
      expect([...nal.slice(5)]).toEqual([0x00, 0x00, 0x03, b]);
    }
  });

  it("leaves 0x04 and above alone", () => {
    const nal = toNalUnit(new Uint8Array([0x00, 0x00, 0x04]), 0, 1);
    expect([...nal.slice(5)]).toEqual([0x00, 0x00, 0x04]);
  });

  it("restarts the zero run after an inserted byte", () => {
    // 00 00 00 00 needs an escape after each pair, not one for the whole run.
    const nal = toNalUnit(new Uint8Array([0x00, 0x00, 0x00, 0x00]), 0, 1);
    expect([...nal.slice(5)]).toEqual([0x00, 0x00, 0x03, 0x00, 0x00]);
  });
});

describe("B-slice 16x8 macroblock types", () => {
  it("maps both partition prediction modes to Table 7-14", () => {
    expect(b16x8MbType("L0", "L0")).toBe(4);
    expect(b16x8MbType("L1", "L1")).toBe(6);
    expect(b16x8MbType("L0", "L1")).toBe(8);
    expect(b16x8MbType("L1", "L0")).toBe(10);
    expect(b16x8MbType("L0", "BI")).toBe(12);
    expect(b16x8MbType("BI", "L1")).toBe(18);
    expect(b16x8MbType("BI", "BI")).toBe(20);
  });
});

describe("I_PCM macroblocks", () => {
  it("byte-aligns and writes all 4:2:0 samples", () => {
    const w = new BitWriter();
    const luma = Uint8Array.from({ length: 256 }, (_, i) => i);
    const cb = new Uint8Array(64).fill(0x55);
    const cr = new Uint8Array(64).fill(0xaa);
    writePcmMacroblock(w, "I", { luma, cb, cr });
    const out = w.bytes();
    expect(out).toHaveLength(386);
    expect([...out.subarray(0, 4)]).toEqual([0x0d, 0x00, 0x00, 0x01]);
    expect([...out.subarray(258, 262)]).toEqual([0x55, 0x55, 0x55, 0x55]);
    expect([...out.subarray(-4)]).toEqual([0xaa, 0xaa, 0xaa, 0xaa]);
  });
});
