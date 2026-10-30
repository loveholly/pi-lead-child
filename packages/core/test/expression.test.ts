import { describe, expect, it } from "vitest";
import { EXPRESSION_SECTION } from "../src/expression.js";

// 2026-10-19 用户要求：输出按 ISO 平白语言标准写，避免废话；内容多时用表格；STE 规则不再用。
describe("expression section", () => {
  it("is organised by the four ISO 24495-1 principles", () => {
    expect(EXPRESSION_SECTION).toContain("ISO 24495-1");
    for (const heading of ["### 相关：", "### 可找到：", "### 看得懂", "### 可用："]) {
      expect(EXPRESSION_SECTION).toContain(heading);
    }
  });

  it("asks the writer to cut filler with a per-sentence check", () => {
    expect(EXPRESSION_SECTION).toContain("不写开场白");
    expect(EXPRESSION_SECTION).toContain("删掉它，读者会少知道什么、或者少做什么吗？不会，就删掉。");
    expect(EXPRESSION_SECTION).toContain("第一句就是答案或结论。");
  });

  // 2026-10-19 部署后的 3 条 Lead 回复反复出现这些问题，原来的规则没有点名。
  it("names the failures seen in Lead's replies after the first deploy", () => {
    expect(EXPRESSION_SECTION).toContain("不把用户刚说的话换个说法再讲一遍。列表不重复第一句已经说过的内容。");
    expect(EXPRESSION_SECTION).toContain("要用户回复时，用一个具体的问题结束");
    expect(EXPRESSION_SECTION).toContain("提议只说一次，不写「随时告诉我」");
    expect(EXPRESSION_SECTION).toContain("不给每个列表项加粗体标签");
    expect(EXPRESSION_SECTION).toContain("不用抽象词拼成的短语，写出具体的事");
    expect(EXPRESSION_SECTION).toContain("工单标题也写成一句普通的话");
    expect(EXPRESSION_SECTION).toContain("不把状态字段和工具参数（draft、hold: true、runtime=claude）原样贴给用户");
  });

  it("ends with one bad and one good example taken from a real reply", () => {
    const examples = EXPRESSION_SECTION.slice(EXPRESSION_SECTION.indexOf("### 例子"));
    expect(examples).toContain("不写：已为你建好待办工单 **#100**");
    expect(examples).toContain("写：建好了 #100，先不开工。");
    expect(EXPRESSION_SECTION.trimEnd().endsWith("或者在工单里点「确认开跑」。")).toBe(true);
  });

  // 用户采纳：旧文风规则里的三条可信度规则放回「可用」。
  it("keeps the three credibility rules under 可用", () => {
    const usable = EXPRESSION_SECTION.slice(EXPRESSION_SECTION.indexOf("### 可用："), EXPRESSION_SECTION.indexOf("### 按信息的形状选形式"));
    expect(usable).toContain("不编造。");
    expect(usable).toContain("如实写验证。");
    expect(usable).toContain("证据要能定位：工单写 #编号，Run 写 Run #编号，代码写 `路径:行号`");
  });

  // 用户要求：画图维持现状（代码块里的字符画），不引导模型写 Mermaid。App 不渲染 Mermaid。
  it("chooses the form by the shape of the information, without Mermaid", () => {
    expect(EXPRESSION_SECTION).toContain("用表格。表格前先用一句话写结论");
    expect(EXPRESSION_SECTION).toContain("工单正文、plc 和 Slack 里用 Markdown 表格。");
    expect(EXPRESSION_SECTION).toContain("在代码块里用字符画图");
    expect(EXPRESSION_SECTION.toLowerCase()).not.toContain("mermaid");
  });

  it("leaves code and quoted text as they are, and lets the user override", () => {
    expect(EXPRESSION_SECTION).toContain("代码、命令、路径、标识符、报错和日志原文、引用的原文照原样写。");
    expect(EXPRESSION_SECTION).toContain("用户对写法或格式有明确要求时，按用户的要求写。");
  });

  it("does not bring back the STE rules", () => {
    for (const marker of ["STE", "简化技术中文", "状态词", "写作文风"]) {
      expect(EXPRESSION_SECTION).not.toContain(marker);
    }
  });
});
