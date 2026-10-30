// 工单 14 的决策边界：tail 按字节偏移读 output.jsonl，没写完的最后一行留到下次。
import { describe, expect, it } from "vitest";
import { decodeOutputFrames } from "../src/launcher.js";

const frame = (stream: "stdout" | "stderr", text: string) => `${JSON.stringify({ stream, text })}\n`;

describe("decodeOutputFrames", () => {
  it("returns the complete frames and their byte offsets in the file", () => {
    const first = frame("stdout", "a\n");
    const second = frame("stderr", "warn");
    const bytes = Buffer.from(first + second);
    expect(decodeOutputFrames(bytes, 100)).toEqual({
      frames: [
        { stream: "stdout", text: "a\n", start: 100, end: 100 + first.length },
        { stream: "stderr", text: "warn", start: 100 + first.length, end: 100 + bytes.length },
      ],
      consumed: bytes.length,
    });
  });

  it("leaves a frame without its newline for the next read", () => {
    const complete = frame("stdout", "done\n");
    const partial = frame("stdout", "half").slice(0, 10);
    const result = decodeOutputFrames(Buffer.from(complete + partial), 0);
    expect(result.frames.map((item) => item.text)).toEqual(["done\n"]);
    expect(result.consumed).toBe(complete.length);
  });

  it("counts offsets in bytes, so multi-byte text does not shift the next frame", () => {
    const first = frame("stdout", "日志：完成\n");
    const second = frame("stdout", "next\n");
    const result = decodeOutputFrames(Buffer.from(first + second), 0);
    expect(Buffer.byteLength(first)).toBeGreaterThan(first.length);
    expect(result.frames[1]).toMatchObject({ text: "next\n", start: Buffer.byteLength(first) });
    expect(result.consumed).toBe(Buffer.byteLength(first + second));
  });

  it("does not decode a frame whose multi-byte character is cut by the read", () => {
    const bytes = Buffer.from(frame("stdout", "完成\n"));
    const cut = bytes.subarray(0, bytes.indexOf(Buffer.from("成")) + 1);
    expect(decodeOutputFrames(cut, 0)).toEqual({ frames: [], consumed: 0 });
  });

  it("skips a line that is not a frame, so the tail does not stop on it", () => {
    const bytes = Buffer.from(`not json\n{"stream":"stdin","text":"x"}\n${frame("stdout", "ok\n")}`);
    const result = decodeOutputFrames(bytes, 0);
    expect(result.frames.map((item) => item.text)).toEqual(["ok\n"]);
    expect(result.consumed).toBe(bytes.length);
  });
});
