// 生产端一半的事件 payload 契约。消费端那一半在
// apps/companion/src/state/control-plane/protocolAdapter.test.ts 的 "daemon payload shapes"。
//
// 为什么要两侧各钉一遍：companion 的 protocolAdapter 曾经用 additionalProperties:false 校验
// payload，而这里的助手一直在往 payload 里放 ticketId / snapshotRequired。两边各自的测试都是
// 绿的——companion 只测自己造的 { snapshotRequired: true }，这里根本没测过键集——于是
// "生产端发的每一条带 ticketId 的 ticket.updated 都被 companion 丢掉" 这件事没有任何测试看得见。
// 现在键集在这里冻结：这里改了，companion 那侧的用例就必须同步改，反之亦然。
import { describe, expect, it } from "vitest";

import {
  itemUpdatedEvent,
  runStartedEvent,
  runUpdatedEvent,
} from "@pi-lead-child/store";
import { projectToolEvent } from "../src/event-projection.js";

const keysOf = (payload: Record<string, unknown>) => Object.keys(payload).sort();

describe("gateway event payload shapes", () => {
  it("itemUpdatedEvent names the item inside the payload", () => {
    const event = itemUpdatedEvent(7);
    expect(event.type).toBe("ticket.updated");
    expect(event.requiredScope).toBe("tickets:view");
    expect(event.itemId).toBe(7);
    expect(keysOf(event.payload)).toEqual(["snapshotRequired", "ticketId"]);
  });

  it("run events carry attemptId plus the routing ticketId, and never a state field", () => {
    for (const event of [runStartedEvent(7, 4), runUpdatedEvent(7, 4)]) {
      expect(keysOf(event.payload)).toEqual(["attemptId", "snapshotRequired", "ticketId"]);
      expect(event.payload).not.toHaveProperty("state");
    }
    expect(runStartedEvent(7, 4).type).toBe("attempt.started");
    expect(runUpdatedEvent(7, 4).type).toBe("attempt.updated");
  });

  it("projectToolEvent adds operationState next to the tool identity", () => {
    expect(keysOf(projectToolEvent({
      type: "tool_execution_start", callId: "call-1", name: "create_task", args: {},
    }))).toEqual(["args", "operationState", "toolCallId", "toolName"]);
    expect(keysOf(projectToolEvent({
      type: "tool_execution_end", callId: "call-1", name: "create_task", result: {}, isError: false,
    }))).toEqual(["isError", "operationState", "result", "toolCallId", "toolName"]);
  });

  it("projectToolEvent keeps why a runtime tool failed", () => {
    const payload = projectToolEvent({ type: "tool.failed", callId: "call-1", name: "Bash", error: "exit code 1" });
    expect(keysOf(payload)).toEqual(["error", "isError", "operationState", "toolCallId", "toolName"]);
    expect(payload.error).toBe("exit code 1");
  });
});

// 第二轮发布评审：工具事件在 daemon 的同步事件路径上投影。一个几 MB 的工具输出不能卡住它，
// 而且投影出去的 payload 里已经没有密钥（命令、嵌套的 JSON 文本、Python 字典）。
describe("tool event projection and secrets", () => {
  it("scrubs secrets in commands and in JSON text before the payload leaves the daemon", () => {
    const payload = projectToolEvent({
      type: "tool_execution_end", callId: "call-1", name: "bash", isError: false,
      result: {
        content: [
          { type: "text", text: '{"data":{"password":"hunter2","access_token":"ya29.FAKEaccess0123456789"}}' },
          { type: "text", text: "kubectl create secret generic db --from-literal=password=hunter2" },
          { type: "text", text: "{'password': 'hunter2'} http --auth admin:hunter2 --env=MYSQL_ROOT_PASSWORD=hunter2" },
        ],
      },
    });
    const text = JSON.stringify(payload);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("ya29.FAKE");
  });

  it("truncates a huge output before it redacts, so the projection stays fast", () => {
    const huge = "a.".repeat(512 * 1024);
    const start = performance.now();
    const payload = projectToolEvent({ type: "tool_execution_end", callId: "c", name: "read", result: huge, isError: false });
    expect(performance.now() - start).toBeLessThan(50);
    expect(String(payload.result)).toMatch(/\.\.\.\[TRUNCATED\]$/);
  });
});
