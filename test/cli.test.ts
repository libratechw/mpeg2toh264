import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { wrapMpeg2EsInTs } from "./ts-fixture.ts";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "tools/mpeg2toh264.ts");
const temp = mkdtempSync(join(tmpdir(), "mpeg2toh264-cli-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function run(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", cli, ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

describe("mpeg2toh264 CLI", () => {
  it("shows help", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: mpeg2toh264");
  });

  it("requires distinct input and output paths", () => {
    const fixture = join(root, "testdata/i_only.m2v");
    const result = run([fixture, fixture]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("input and output must be different");
  });

  it("writes a raw H.264 Annex B stream", () => {
    const output = join(temp, "output.h264");
    const result = run([
      "--oversample",
      "2",
      "--i-frames-only",
      join(root, "testdata/i_only.m2v"),
      output,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pictures converted");
    expect(Array.from(readFileSync(output).subarray(0, 4))).toEqual([
      0, 0, 0, 1,
    ]);
  });

  it("writes timestamped fragmented MP4 when the output ends in .mp4", () => {
    const output = join(temp, "output.mp4");
    const result = run([join(root, "testdata/ibbp.m2v"), output]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("(fragmented MP4)");
    const text = new TextDecoder("latin1").decode(readFileSync(output));
    expect(text).toContain("ftyp");
    expect(text).toContain("moov");
    expect(text).toContain("moof");
    expect(text).toContain("mdat");
  });

  it("demuxes an MPEG transport stream before transcoding", () => {
    const es = new Uint8Array(readFileSync(join(root, "testdata/i_only.m2v")));
    const input = join(temp, "input.ts");
    const output = join(temp, "transport-output.h264");
    writeFileSync(input, wrapMpeg2EsInTs(es));
    const result = run([input, output]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("(MPEG-TS)");
    expect(Array.from(readFileSync(output).subarray(0, 4))).toEqual([
      0, 0, 0, 1,
    ]);
  });
});
