import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
  CHAT_IMAGE_MAX_BASE64_LENGTH, CHAT_IMAGE_MAX_COUNT, ChatSendCommandSchema, ConversationTurnSchema, sniffChatImageMimeType,
} from "../src/index.js";

const command = { type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "看图" };
const image = { mimeType: "image/png", data: "iVBORw0KGgo=" };

describe("chat images on the wire", () => {
  it("lets chat.send carry 1 to 8 images of the four formats the model services take", () => {
    expect(Value.Check(ChatSendCommandSchema, { ...command, images: [image] })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, {
      ...command, images: ["image/png", "image/jpeg", "image/webp", "image/gif"].map((mimeType) => ({ ...image, mimeType })),
    })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, { ...command, images: [] })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, {
      ...command, images: Array.from({ length: CHAT_IMAGE_MAX_COUNT + 1 }, () => image),
    })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, { ...command, images: [{ ...image, mimeType: "image/svg+xml" }] })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, { ...command, images: [{ ...image, name: "a.png" }] })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, {
      ...command, images: [{ ...image, data: "A".repeat(CHAT_IMAGE_MAX_BASE64_LENGTH + 1) }],
    })).toBe(false);
  });

  it("allows a message with only images: the text may be empty", () => {
    expect(Value.Check(ChatSendCommandSchema, { ...command, message: "", images: [image] })).toBe(true);
  });

  it("adds a turn's images only as an optional field", () => {
    const turn = {
      id: "turn-1", originBindingId: 1, originKind: "paired:companion", ticketId: null, state: "completed",
      userText: "看图", assistantText: "好", error: null, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "2026-10-25T00:00:00.000Z",
    };
    expect(Value.Check(ConversationTurnSchema, turn)).toBe(true);
    expect(Value.Check(ConversationTurnSchema, { ...turn, images: [{ id: "img_a", mimeType: "image/png" }] })).toBe(true);
    expect(Value.Check(ConversationTurnSchema, { ...turn, images: [{ id: "img_a", mimeType: "image/png", data: "x" }] })).toBe(false);
  });

  it("recognizes the four formats by their file header", () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    expect(sniffChatImageMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffChatImageMimeType(bytes(0xff, 0xd8, 0xff, 0xe1))).toBe("image/jpeg");
    expect(sniffChatImageMimeType(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
    expect(sniffChatImageMimeType(new TextEncoder().encode("GIF87a..."))).toBe("image/gif");
    expect(sniffChatImageMimeType(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toBe("image/webp");
    expect(sniffChatImageMimeType(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WAVE"))).toBeNull();
    expect(sniffChatImageMimeType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffChatImageMimeType(bytes())).toBeNull();
  });
});
