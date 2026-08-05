import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

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
    const fixture = join(root, "test/fixtures/i_only.m2v");
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
      join(root, "test/fixtures/i_only.m2v"),
      output,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pictures converted");
    expect(Array.from(readFileSync(output).subarray(0, 4))).toEqual([
      0, 0, 0, 1,
    ]);
  });
});
