// 工具参数和结果里的密钥：会话快照的折叠、实时事件的折叠和网关落库前的投影都用这一套规则。
// 这些用例是发布评审给的样本（值是假的）：每一个密钥值都不能出现在展示文本里。
import { describe, expect, it } from "vitest";

import {
  foldTurnToolCalls,
  isSecretEnvName,
  isSensitiveFieldName,
  looksLikeSecretValue,
  projectToolDisplay,
  redactAndCap,
  redactKnownValues,
  redactSecretText,
  secretEnvValues,
} from "../src/index.js";

const GH_TOKEN = "ghp_FAKEaaaaBBBBccccDDDDeeeeFFFFgggg1234";
const GHO_TOKEN = "gho_FAKE9999zzzzYYYYxxxxWWWWvvvvUUUU0000";
const GLPAT = "glpat-FAKEabcdefghij0123";
const PEM = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "QyNTUxOQAAACBFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEAAAA=",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

// [输入, 不能出现的值, 必须留下的文字]
const SAMPLES: Array<[string, string[], string[]]> = [
  [`curl -H 'Authorization: token ${GH_TOKEN}' https://api.github.com/user`, [GH_TOKEN, "token ghp"], ["curl -H", "https://api.github.com/user"]],
  ["curl -H 'Authorization: Bearer abc.def.ghi' https://x", ["abc.def.ghi"], ["https://x"]],
  ["Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==", ["dXNlcjpwYXNzd29yZA=="], ["Proxy-Authorization"]],
  ["curl -u admin:hunter2 https://x", ["hunter2"], ["admin", "https://x"]],
  ["curl --user=admin:hunter2 https://x", ["hunter2"], ["admin"]],
  [`git clone https://oauth2:${GLPAT}@gitlab.com/group/repo.git`, [GLPAT], ["gitlab.com/group/repo.git"]],
  [`git push https://bwen:${GH_TOKEN}@github.com/o/r`, [GH_TOKEN], ["github.com/o/r"]],
  ["DATABASE_URL=postgres://app:p4ssw0rd@db:5432/app", ["p4ssw0rd"], ["DATABASE_URL", "db:5432/app"]],
  ["curl -H 'Cookie: session=abc123def456; theme=dark' https://x", ["abc123def456"], ["https://x"]],
  ["Set-Cookie: sid=xyz789secret; HttpOnly", ["xyz789secret"], ["Set-Cookie"]],
  [`${GHO_TOKEN}\n`, [GHO_TOKEN], []],
  [`key:\n${PEM}\nafter`, ["b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "QyNTUxOQAAACBFAKE"], ["after"]],
  ["mysql -uroot -pS3cret appdb", ["S3cret"], ["mysql -uroot", "appdb"]],
  ["mysqldump -h db -pS3cret --all-databases", ["S3cret"], ["--all-databases"]],
  ["login --password=hunter2 --verbose", ["hunter2"], ["--verbose"]],
  ["login --password hunter2", ["hunter2"], ["login"]],
  ["export GITHUB_TOKEN=abc123xyz && API_KEY=k-999 run", ["abc123xyz", "k-999"], ["export", "run"]],
  ["github_pat_11FAKEFAKE0abcdefghijklmnopqrstuvwxyz0123456789", ["github_pat_11FAKEFAKE0abcdefghij"], []],
  ["SLACK=xoxb-123456789012-abcdefghijkl", ["xoxb-123456789012-abcdefghijkl"], []],
  // slack-takeover 工单 02：Socket Mode 的 app-level token（xapp-）、用户令牌（xoxp-）和会轮换的令牌（xoxe.），不跟在变量名后面时也认得出。
  ["apps.connections.open with xapp-1-A0FAKE12345-1234567890123-abcdef0123456789 failed", ["xapp-1-A0FAKE12345", "abcdef0123456789"],
    ["apps.connections.open with", "failed"]],
  ["user token xoxp-1234567890-0987654321-FAKEabcdef", ["xoxp-1234567890-0987654321-FAKEabcdef"], ["user token"]],
  ["rotated xoxe.xoxp-1-FAKEabcdefghijklmnop0123", ["xoxe.xoxp-1-FAKEabcdefghij", "FAKEabcdefghijklmnop0123"], ["rotated"]],
  ["sk-ant-api03-FAKEabcdefghijklmnopqrstuvwxyz", ["sk-ant-api03-FAKEabcdefghij"], []],
  ["key sk-proj-FAKEabcdefghijklmnop0123", ["sk-proj-FAKEabcdefghijklmnop"], []],
  ["aws AKIAIOSFODNN7EXAMPLE", ["AKIAIOSFODNN7EXAMPLE"], ["aws"]],
  ["maps AIzaSyFAKE-abcdefghijklmnopqrstuvwxyz0", ["AIzaSyFAKE-abcdefghijklmnopqrstuvwxyz0"], ["maps"]],
  ['{"password": "hunter2", "page": 1', ["hunter2"], ['"page": 1']],
  ['{"api_key":"k-1","stage":"review"}', ["k-1"], ['"stage":"review"']],
  // 第二轮评审（cb8a582 之后）找到的漏网形式。
  ["aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", ["wJalrXUtnFEMI"], ["aws configure set aws_secret_access_key"]],
  ["aws configure set aws_session_token FwoGZXIvYXdzEFAKEsession", ["FwoGZXIvYXdzEFAKEsession"], ["aws_session_token"]],
  ["kubectl create secret generic db --from-literal=password=hunter2", ["hunter2"], ["kubectl create secret generic db"]],
  ["docker run --env=MYSQL_ROOT_PASSWORD=hunter2 mysql:8", ["hunter2"], ["mysql:8"]],
  ["helm upgrade app ./chart --set=auth.password=hunter2", ["hunter2"], ["./chart"]],
  ['{"data":{"password":"hunter2"}}', ["hunter2"], ['"data"']],
  ['{"items":[{"token":"abc123secret"}]}', ["abc123secret"], ['"items"']],
  ['{"data":{"access_token":"ya29.FAKEaccess0123456789"}}', ["ya29.FAKEaccess0123456789"], ['"data"']],
  ['{"credentials":{"user":"u","pass":"p4ss-in-object"}}', ["p4ss-in-object"], []],
  ['{"auths":{"registry.io":{"auth":"YWRtaW46aHVudGVyMg=="}}}', ["YWRtaW46aHVudGVyMg=="], ["registry.io"]],
  ["//registry.npmjs.org/:_auth=YWRtaW46aHVudGVyMg==", ["YWRtaW46aHVudGVyMg=="], ["registry.npmjs.org"]],
  ["http --auth admin:hunter2 https://x", ["hunter2"], ["https://x"]],
  ["{'password': 'hunter2', 'user': 'bob'}", ["hunter2"], ["'user': 'bob'"]],
  ["Authorization=Bearer abc.def-ghi_jkl", ["abc.def-ghi_jkl"], ["Authorization"]],
  ['{"key":"k-secret-1","sort_key":"name"}', ["k-secret-1"], ['"sort_key":"name"']],
  ["secret_key=s-1 client_key=c-1 signing_key=g-1 sort_key=name", ["s-1", "c-1", "g-1"], ["sort_key=name"]],
  ["gpg --import --key abc-key-value", ["abc-key-value"], ["gpg --import"]],
  ["-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBFAKEFAKEFAKE\n-----END PGP PRIVATE KEY BLOCK-----", ["lQOYBFAKEFAKEFAKE"], []],
  ["curl -uadmin:pw123 https://x", ["pw123"], ["https://x"]],
  ["sshpass -p hunter2 ssh host", ["hunter2"], ["ssh host"]],
  ["docker login -u bob -p hunter2 registry.io", ["hunter2"], ["registry.io"]],
  ["npm_FAKEabcdefghijklmnopqrstuvwxyz012345", ["npm_FAKEabcdefghijklmnopqrstuvwxyz012345"], []],
  ["stripe sk_live_FAKEabcdefghijklmnop", ["sk_live_FAKEabcdefghijklmnop"], ["stripe"]],
  ["token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.FAKEsignature_abc-123", ["eyJzdWIiOiIxMjM0In0", "FAKEsignature_abc-123"], []],
];

describe("secrets in free text", () => {
  it.each(SAMPLES)("hides the secret in %j", (input, secrets, kept) => {
    const output = redactSecretText(input);
    for (const secret of secrets) expect(output).not.toContain(secret);
    for (const text of kept) expect(output).toContain(text);
  });

  it("leaves ordinary text and flags alone", () => {
    for (const text of [
      "author=bob sort_key=name keyboard=us",
      '{"author":"bob","sort_key":"name","keyboard":"us","max_tokens":10}',
      "kubectl get pods --namespace=default --output=json",
      "mkdir -p build && ssh -p 22 host",
      "npm run test:core-invariants",
      "git -C ~/work/repo log --oneline -3",
      "https://github.com/o/r/pull/12",
      "max_tokens=4096",
    ]) {
      expect(redactSecretText(text)).toBe(text);
    }
  });

  it("gives the same text when it runs twice", () => {
    for (const [input] of SAMPLES) {
      const once = redactSecretText(input);
      expect(redactSecretText(once)).toBe(once);
    }
  });
});

describe("secret field names", () => {
  it("match by word, not by any substring", () => {
    for (const name of [
      "token", "accessToken", "refresh_token", "csrfToken", "client_secret", "password", "passwd", "pwd",
      "api_key", "apiKey", "X-Api-Key", "apikey", "access_key", "AWS_SECRET_ACCESS_KEY", "private_key", "privateKey",
      "Authorization", "Proxy-Authorization", "auth_token", "authToken", "credential", "credentials",
      "cookie", "Set-Cookie", "ssh_key", "auth", "_auth", "auth.password", "key", "KEY", "secret_key",
      "client_key", "signing_key", "aws_session_token",
    ]) {
      expect.soft(isSensitiveFieldName(name), name).toBe(true);
    }
    for (const name of ["author", "authority", "oauth", "sort_key", "keyboard", "keys", "max_tokens", "inputTokens", "path", "command", "stage"]) {
      expect.soft(isSensitiveFieldName(name), name).toBe(false);
    }
  });
});

describe("tool display projection", () => {
  it("hides secret fields and secrets inside every string, at any depth", () => {
    const projection = projectToolDisplay({
      command: `curl -u admin:hunter2 -H 'Authorization: token ${GH_TOKEN}' https://x`,
      env: { DATABASE_URL: "postgres://app:p4ssw0rd@db", Cookie: "session=abc123def456" },
      author: "bob",
      sort_key: "name",
      output: [`${GHO_TOKEN}`, PEM],
    })!;
    for (const secret of ["hunter2", GH_TOKEN, "p4ssw0rd", "abc123def456", GHO_TOKEN, "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ"]) {
      expect(projection.preview).not.toContain(secret);
    }
    expect(projection.preview).toContain('"author":"bob"');
    expect(projection.preview).toContain('"sort_key":"name"');
    expect(projection.redacted).toBe(true);
  });

  it("hides secrets in the error text of a failed call", () => {
    const [call] = foldTurnToolCalls([
      { type: "child.tool.started", occurredAt: "2026-10-14T00:00:01.000Z", payload: { toolCallId: "a", toolName: "Bash", args: { command: "gh auth token" }, textOffset: 0 } },
      { type: "child.tool.failed", occurredAt: "2026-10-14T00:00:02.000Z", payload: { toolCallId: "a", toolName: "Bash", isError: true, error: `token ${GHO_TOKEN} expired` } },
    ]);
    expect(call!.error).not.toContain(GHO_TOKEN);
    expect(call!.error).toContain("expired");
  });
});

// 第二轮评审：redactSecretText 跑在 daemon 的同步事件路径上。以前三条规则从每个起点扫到输入末尾，
// 一个 200 KB 的文件读出来就要 52 秒。现在每条规则都是线性的，调用方也先截断再脱敏。
describe("redaction time", () => {
  const MB = 1024 * 1024;
  const pad = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB);
  const record = '{"name":"mysql","host":"db-1","port":3306,"user":"app"},';
  // 前三个是评审测出来的（旧规则：1.7 秒、1.4 秒、52 秒），其余是各条规则自己的最坏输入。
  const ADVERSARIAL: Array<[string, string]> = [
    ["example.", pad("example.")],
    ["JSON records with mysql", `[${pad(record)}`],
    ["a.", pad("a.")],
    ["dash-joined eyJ", pad("eyJ-")],
    ["quoted keys", pad('"a":')],
    ["assignments", pad("x=")],
    ["URL schemes", pad("://a:")],
    ["open PEM blocks", pad("-----BEGIN RSA PRIVATE KEY-----")],
    ["Bearer words", pad("Bearer ")],
  ];

  function fastest(run: () => void): number {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  it.each(ADVERSARIAL)("redacts 1 MB of %s in under 50 ms", (_name, input) => {
    expect(fastest(() => redactSecretText(input))).toBeLessThan(50);
  });

  it("truncates before it redacts", () => {
    const input = pad("a.");
    expect(fastest(() => projectToolDisplay({ output: input }))).toBeLessThan(50);
    const capped = redactAndCap(`${"x ".repeat(3_000)}password=hunter2 ${"y ".repeat(3_000)}`, 4_096);
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBe(4_096);
    expect(capped.text).not.toContain("hunter2");
  });

  it("still catches a secret that straddles the cut", () => {
    const capped = redactAndCap(`${"x".repeat(4_090)} token=abcdef0123456789`, 4_096);
    expect(capped.text).not.toContain("abcdef");
    expect(capped.redacted).toBe(true);
  });
});

// 已知密钥的值（2026-10-19 审查，发现 7）：名字和值都要像密钥，才按值盖掉。
describe("secret values from the environment", () => {
  it("counts *_KEY, *_PAT and *_PASS names as secret names only for environment variables", () => {
    for (const name of ["AM_API_KEY", "OPENROUTER_KEY", "GH_TOKEN", "GITHUB_PAT", "DB_PASS", "AWS_SECRET_ACCESS_KEY"]) {
      expect(isSecretEnvName(name), name).toBe(true);
    }
    for (const name of ["HOME", "PATH", "LEAD_MODEL", "KEYBOARD_LAYOUT"]) expect(isSecretEnvName(name), name).toBe(false);
    // 字段名的规则不变：sort_key 不是密钥。
    expect(isSensitiveFieldName("sort_key")).toBe(false);
  });

  it("only masks values that look like secrets", () => {
    const values = secretEnvValues({
      AM_API_KEY: "am-live-7Hq2Zx9Lw4Pr8Kt1", OPENROUTER_KEY: "sk-or-v1-0123456789abcdef0123",
      PI_MODEL_KEY: "antigravity/gemini-3", LEAD_MODEL_KEY: "antigravity/gemini-3-pro-2026",
      SSH_AUTH_SOCK: "/private/tmp/agent.sock", SHORT_TOKEN: "abc12",
      SERVICE_URL_TOKEN: "https://example.test/a1b2", WORDS_PASS: "correct horse battery 12",
    });
    expect(values.sort()).toEqual(["am-live-7Hq2Zx9Lw4Pr8Kt1", "sk-or-v1-0123456789abcdef0123"]);
    expect(redactKnownValues("model antigravity/gemini-3 key am-live-7Hq2Zx9Lw4Pr8Kt1", values))
      .toBe("model antigravity/gemini-3 key [REDACTED]");
  });

  it("always masks the Keychain-injected keys, whatever they look like", () => {
    expect(secretEnvValues({ AM_API_KEY: "am-short-1", TAVILY_API_KEY: "tvly-abc" })).toEqual(["am-short-1", "tvly-abc"]);
  });

  it("rejects paths, URLs, short strings, words and model names (review round 3, finding 4)", () => {
    expect(looksLikeSecretValue("antigravity/gemini-3")).toBe(false);
    expect(looksLikeSecretValue("antigravity/gemini-3-pro-2026")).toBe(false);
    expect(looksLikeSecretValue("claude-opus-4-1-20250805")).toBe(false);
    expect(looksLikeSecretValue("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(true);
    expect(looksLikeSecretValue("/Users/x/.ssh/agent")).toBe(false);
    expect(looksLikeSecretValue("ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5")).toBe(true);
  });
});
