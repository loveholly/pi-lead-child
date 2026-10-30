import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem, getItem, listItems, appendBody } from "../src/items.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-"), "plc.db")); });

describe("items DAO", () => {
  it("creates and reads an item with defaults", () => {
    const id = createItem(db, { title: "调研 X", brief: "调研 X 的可行性", createdBy: "user" });
    const t = getItem(db, id)!;
    expect(t.title).toBe("调研 X");
    // 缺省是 ready：不传 hold 就是"建完即跑"，停在 draft 是 hold 才有的效果（见 item-hold）。
    expect(t.stage).toBe("ready");
    expect(t.body).toBe("");
    expect(t.workdir).toBeNull();
  });

  it("lists items filtered by stage", () => {
    createItem(db, { title: "a", brief: "a", createdBy: "user", hold: true }); // → draft
    createItem(db, { title: "b", brief: "b", createdBy: "lead" }); // → ready
    expect(listItems(db).length).toBe(2);
    expect(listItems(db, { stage: ["done"] }).length).toBe(0);
    expect(listItems(db, { stage: ["draft"] }).length).toBe(1);
    expect(listItems(db, { stage: ["ready"] }).length).toBe(1);
  });

  it("appends body sections with separator", () => {
    const id = createItem(db, { title: "a", brief: "a", createdBy: "user" });
    appendBody(db, id, "第一阶段完成");
    appendBody(db, id, "第二阶段完成");
    const body = getItem(db, id)!.body;
    expect(body).toContain("第一阶段完成");
    expect(body).toContain("第二阶段完成");
    expect(body.indexOf("第二阶段")).toBeGreaterThan(body.indexOf("第一阶段"));
  });
});
