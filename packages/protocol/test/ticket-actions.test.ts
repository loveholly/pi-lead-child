// 工单操作的线上契约（工单 03）。ticket-actions.ts 不能 import index.ts，所以优先级和关系类型的取值另写了一份：
// 这里核对它们和 index.ts 的是同一组，免得一边加了取值、另一边的操作收不进去。
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  TICKET_ACTION_IDS, TICKET_ACTION_INPUT_SCHEMAS, TICKET_ACTION_PRIORITIES, TICKET_ACTION_RELATION_KINDS,
  TicketActionRunRequestSchema, TicketActionsResponseSchema, TicketPrioritySchema, TicketRelationKindSchema,
} from "../src/index.ts";

const literalsOf = (schema: { anyOf: Array<{ const: string }> }) => schema.anyOf.map((option) => option.const).sort();

describe("ticket action wire contract", () => {
  it("uses the same priority and relation values as the ticket schemas", () => {
    expect([...TICKET_ACTION_PRIORITIES].sort()).toEqual(literalsOf(TicketPrioritySchema as never));
    expect([...TICKET_ACTION_RELATION_KINDS].sort()).toEqual(literalsOf(TicketRelationKindSchema as never));
  });

  it("has one input schema per action and nothing else", () => {
    expect(Object.keys(TICKET_ACTION_INPUT_SCHEMAS).sort()).toEqual([...TICKET_ACTION_IDS].sort());
    expect(new Set(TICKET_ACTION_IDS).size).toBe(TICKET_ACTION_IDS.length);
  });

  it("rejects unknown input fields, so a typo is an error instead of a silent no-op", () => {
    expect(Value.Check(TICKET_ACTION_INPUT_SCHEMAS.set_priority, { priority: "high" })).toBe(true);
    expect(Value.Check(TICKET_ACTION_INPUT_SCHEMAS.set_priority, { priority: "high", actor: "lead" })).toBe(false);
    expect(Value.Check(TICKET_ACTION_INPUT_SCHEMAS.merge, { expectedHead: "abc" })).toBe(false);
    expect(Value.Check(TICKET_ACTION_INPUT_SCHEMAS.merge, { expectedHead: "a".repeat(40), expectedTarget: "main" })).toBe(true);
    expect(Value.Check(TicketActionRunRequestSchema, { input: {}, reason: "r", actor: "user" })).toBe(false);
  });

  it("keeps the action id open in the listing, so old clients survive a new action", () => {
    expect(Value.Check(TicketActionsResponseSchema, {
      ticketId: 1,
      actions: [{
        id: "an_action_added_later", label: "x", area: "ticket", permission: "user_only",
        external: false, irreversible: false, undoable: false, available: false, reason: "不能做",
      }],
    })).toBe(true);
  });
});

describe("ticket action enums", () => {
  it("lists every input literal and permission in the schemas, not only in the constant arrays", () => {
    const schema = TICKET_ACTION_INPUT_SCHEMAS.link as unknown as { properties: { relationType: { anyOf: Array<{ const: string }> } } };
    expect(schema.properties.relationType.anyOf.map((option) => option.const).sort())
      .toEqual([...TICKET_ACTION_RELATION_KINDS].sort());
    const priority = TICKET_ACTION_INPUT_SCHEMAS.set_priority as unknown as { properties: { priority: { anyOf: Array<{ const: string }> } } };
    expect(priority.properties.priority.anyOf.map((option) => option.const).sort()).toEqual([...TICKET_ACTION_PRIORITIES].sort());
  });
});
