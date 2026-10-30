import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { attachJsonlReader } from "../src/jsonl.js";

function collect(chunks: string[]): Promise<string[]> {
  return new Promise((resolve) => {
    const stream = new PassThrough();
    const lines: string[] = [];
    attachJsonlReader(stream, (l) => lines.push(l));
    stream.on("end", () => resolve(lines));
    for (const c of chunks) stream.write(c);
    stream.end();
  });
}

describe("attachJsonlReader", () => {
  it("splits on LF only, even with U+2028 inside JSON strings", async () => {
    const payload = '{"text":"line\u2028sep"}';
    const lines = await collect([payload + "\n", '{"a":1}\n']);
    expect(lines).toEqual([payload, '{"a":1}']);
    expect(JSON.parse(lines[0]).text).toBe("line\u2028sep");
  });

  it("strips trailing CR and handles chunk-split records", async () => {
    const lines = await collect(['{"a":', '1}\r\n{"b"', ":2}\n"]);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("flushes trailing record without newline on end", async () => {
    const lines = await collect(['{"tail":true}']);
    expect(lines).toEqual(['{"tail":true}']);
  });
});
