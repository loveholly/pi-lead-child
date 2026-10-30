import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { htmlToText, fetchUrl, tavilySearch } from "../src/extension/web-tools.js";

describe("htmlToText", () => {
  it("strips scripts/styles/tags, decodes entities, collapses whitespace", () => {
    const html = `<html><head><style>.x{color:red}</style><script>evil()</script></head>
      <body><h1>标题</h1><p>正文 &amp; 内容</p><div>第二段</div></body></html>`;
    const t = htmlToText(html);
    expect(t).not.toContain("evil");
    expect(t).not.toContain("color:red");
    expect(t).not.toContain("<");
    expect(t).toContain("标题");
    expect(t).toContain("正文 & 内容");
    expect(t).toContain("第二段");
  });
});

describe("fetchUrl", () => {
  let server: Server;
  let base: string;
  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.url === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><h1>Hello</h1><p>真实内容 not from memory</p></body></html>");
      } else if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"k":"v"}');
      } else {
        res.writeHead(404); res.end("nope");
      }
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("fetches HTML and returns extracted text", async () => {
    const r = await fetchUrl(`${base}/page`, {});
    expect(r.status).toBe(200);
    expect(r.text).toContain("Hello");
    expect(r.text).toContain("真实内容 not from memory");
    expect(r.text).not.toContain("<h1>");
  });

  it("returns raw body for non-HTML", async () => {
    const r = await fetchUrl(`${base}/json`, {});
    expect(r.text).toBe('{"k":"v"}');
  });

  it("truncates to max_chars", async () => {
    const r = await fetchUrl(`${base}/page`, { maxChars: 5 });
    expect(r.text.length).toBe(5);
    expect(r.truncated).toBe(true);
  });
});

describe("tavilySearch (REST)", () => {
  let server: Server;
  let base: string;
  let lastBody: any;
  beforeEach(async () => {
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/search") {
        let body = ""; req.on("data", (c) => { body += c; });
        req.on("end", () => {
          lastBody = JSON.parse(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ results: [
            { title: "R1", url: "https://a.com", content: "内容一" },
            { title: "R2", url: "https://b.com", content: "内容二" },
          ] }));
        });
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("posts query with bearer auth and parses results", async () => {
    const results = await tavilySearch("分布式系统", { apiKey: "tvly-test", baseUrl: base, maxResults: 3 });
    expect(results.map((r) => r.title)).toEqual(["R1", "R2"]);
    expect(lastBody.query).toBe("分布式系统");
    expect(lastBody.max_results).toBe(3);
  });
});
