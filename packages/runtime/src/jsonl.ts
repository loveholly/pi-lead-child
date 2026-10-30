// pi RPC 要求严格 LF 分帧。禁用 node:readline —— 它把 U+2028/U+2029 也当换行，
// 而这两个字符可以合法出现在 JSON 字符串里（pi docs/rpc.md 明确警告）。
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

export function attachJsonlReader(stream: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    }
  });
}
