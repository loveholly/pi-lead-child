import { describe, it, expect } from "vitest";
import { buildChildPrompt } from "../src/config.js";

describe("buildChildPrompt", () => {
  it("contains brief, body and discipline clauses", () => {
    const p = buildChildPrompt({
      id: 7, title: "调研 X", brief: "调研 X 可行性", body: "已有结论 A",
    } as any);
    expect(p).toContain("#7");
    expect(p).toContain("调研 X 可行性");
    expect(p).toContain("已有结论 A");
    expect(p).toContain("ticket_update");
    expect(p).toContain("无权标记 done");
    expect(p).toContain("成果只通过这次工具调用写入账本");
    expect(p).toContain("只输出 PLC_OUTCOME_V1 而不调用 ticket_update");
    expect(p).not.toContain("还必须包含单行 PLC_OUTCOME_V1");
  });

  it("omits body section when empty", () => {
    const p = buildChildPrompt({ id: 8, title: "t", brief: "b", body: "" } as any);
    expect(p).not.toContain("当前工单正文");
  });
});
