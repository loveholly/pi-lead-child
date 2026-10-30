import { describe, expect, it } from "vitest";
import { isPlaintextServiceUrl, normalizeServiceUrl, SERVICE_URL_MESSAGES, serviceUrlHost, serviceUrlProblem } from "../src/service-url.ts";

// 外部服务地址的校验（src/service-url.ts，2026-10-16 发布评审）。决策模型、远程 embedding、reranker 都走它。
describe("serviceUrlProblem", () => {
  // 2026-10-26 用户决定：公司内网的 LLM gateway 只有 http，任何主机都可以用 http；设置页另外提示明文传输。
  it("accepts https and http on any host", () => {
    for (const url of ["https://api.typesafe.ai", "https://api.example.com/v1?api-version=2024-10-21", "http://127.0.0.1:8080/v1", "http://localhost:3000", "http://[::1]:9000/v1",
      "http://llm-gateway.corp.example.com/v1", "http://10.1.2.3:8000/v1", "http://gateway:4000"]) {
      expect(serviceUrlProblem(url), url).toBeNull();
    }
    expect(serviceUrlProblem("ftp://api.example.com")).toBe("invalid_url");
    expect(serviceUrlProblem("http://[")).toBe("invalid_url");
    expect(serviceUrlProblem("not a url")).toBe("invalid_url");
    // 主机名以点结尾多半是输入错误；未指定地址不是服务的地址。
    for (const url of ["https://api.openai.com./v1", "https://0.0.0.0/v1", "https://0/v1", "https://[::]/v1", "https://[::0]/v1"]) {
      expect(serviceUrlProblem(url), url).toBe("invalid_url");
    }
    expect(serviceUrlProblem("http://0.0.0.0:8080/v1")).toBe("invalid_url");
  });

  it("refuses userinfo and key-like query names", () => {
    expect(serviceUrlProblem("https://user:pass@api.example.com")).toBe("userinfo");
    expect(serviceUrlProblem("https://user@api.example.com")).toBe("userinfo");
    for (const name of ["api_key", "key", "token", "access_token", "subscription-key", "Subscription_Key", "sig", "code", "signature"]) {
      expect(serviceUrlProblem(`https://api.example.com/v1?${name}=abc`), name).toBe("secret_query");
    }
  });

  it("normalizes the URL and gives the host keys are bound to", () => {
    expect(normalizeServiceUrl(" https://API.example.com/v1/ ")).toBe("https://api.example.com/v1");
    expect(normalizeServiceUrl("http://LLM-Gateway.corp.example.com/v1/")).toBe("http://llm-gateway.corp.example.com/v1");
    expect(normalizeServiceUrl("ftp://example.com")).toBeNull();
    expect(serviceUrlHost("https://API.example.com:8443/v1")).toBe("api.example.com:8443");
    expect(serviceUrlHost("http://llm-gateway.corp.example.com:8080/v1")).toBe("llm-gateway.corp.example.com:8080");
    expect(serviceUrlHost("https://u:p@x.example.com")).toBeNull();
    expect(Object.keys(SERVICE_URL_MESSAGES).sort()).toEqual(["invalid_url", "secret_query", "userinfo"]);
  });

  it("marks http to a host other than this Mac as plaintext", () => {
    for (const url of ["http://llm-gateway.corp.example.com/v1", " http://10.1.2.3:8000 ", "http://localhost.evil.example/v1", "http://127.0.0.2:8080/v1"]) {
      expect(isPlaintextServiceUrl(url), url).toBe(true);
    }
    for (const url of ["https://api.example.com/v1", "http://127.0.0.1:8080/v1", "http://LOCALHOST:3000", "http://[::1]:9000/v1", "http://[", "ftp://example.com"]) {
      expect(isPlaintextServiceUrl(url), url).toBe(false);
    }
  });
});
