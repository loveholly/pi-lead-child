// 网关的操作层入口（performUserUiAction）核对调用方凭证的 scope：要有操作定义里写的那一个（审查 2026-10-22 的建议）。
import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { UiActionError } from "@pi-lead-child/engine";
import { createLoopbackBinding, getBinding, openDb, type Db } from "@pi-lead-child/store";
import { performUserUiAction } from "../src/ui-action-routes.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-ui-action-routes-"), "plc.db"));
});

const source = { client: "web" as const, deviceName: "Mac 网页", loopback: true, fromThisMachine: true };

describe("performUserUiAction", () => {
  it("refuses a credential without the scope the definition asks for, and does nothing", async () => {
    const { binding: phone } = createLoopbackBinding(db, { name: "iPhone" });
    const { binding: caller } = createLoopbackBinding(db, { name: "Mac 网页" });
    const ctx = { db, services: {}, log: () => {} };
    const refused = await performUserUiAction(ctx, {
      target: { type: "device", id: phone.id }, action: "revoke", binding: caller, scopes: ["tickets:view", "tickets:create"], source,
    }).then(() => null, (caught: unknown) => caught);
    expect(refused).toBeInstanceOf(UiActionError);
    expect((refused as UiActionError).code).toBe("forbidden");
    expect(getBinding(db, phone.id)?.status).toBe("active");

    const done = await performUserUiAction(ctx, {
      target: { type: "device", id: phone.id }, action: "revoke", binding: caller, scopes: ["admin"], source,
    });
    expect(done.authority).toBe("user");
    expect(getBinding(db, phone.id)?.status).toBe("revoked");
  });
});
