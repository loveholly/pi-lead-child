// get_ticket keeps the two free-text fields of a ticket short: the brief and the body.
// A brief from a handoff or an external message can hold tens of thousands of characters of
// context, and the body grows with every milestone. Sent in full, one get_ticket went over
// ObservationPack's 10 KB line, so two steps later the whole answer became a placeholder.
// By default get_ticket shows the start of the brief and the end of the body (the latest
// milestones). The rest is read page by page with `section` and `offset`; a page stays under
// the 10 KB line, so it is never packed.
// Sizes and offsets are UTF-8 bytes, the unit obs_recall and ObservationPack use.

export const BRIEF_HEAD_BYTES = 4 * 1024;
export const BODY_TAIL_BYTES = 4 * 1024;
export const SECTION_PAGE_BYTES = 8 * 1024;

export type TicketTextSection = "brief" | "body";

const SECTION_NAME: Record<TicketTextSection, string> = { brief: "任务说明", body: "正文" };

function isContinuation(buffer: Buffer, index: number): boolean {
  return index > 0 && index < buffer.length && ((buffer[index] ?? 0) & 0xc0) === 0x80;
}

// Moves a byte index back to the start of the UTF-8 character it falls in.
function charStart(buffer: Buffer, index: number): number {
  let at = Math.min(Math.max(index, 0), buffer.length);
  while (isContinuation(buffer, at)) at -= 1;
  return at;
}

function readCall(itemId: number, section: TicketTextSection, offset: number): string {
  return `get_ticket {"id":${itemId},"section":"${section}","offset":${offset}}`;
}

// The start of the brief, cut at a line end when one falls in the second half of the budget.
export function briefHead(itemId: number, brief: string): string {
  const buffer = Buffer.from(brief, "utf8");
  if (buffer.length <= BRIEF_HEAD_BYTES) return brief;
  let end = charStart(buffer, BRIEF_HEAD_BYTES);
  const newline = buffer.lastIndexOf(0x0a, end - 1);
  if (newline >= BRIEF_HEAD_BYTES / 2) end = newline + 1;
  return `${buffer.subarray(0, end).toString("utf8")}\n`
    + `……（任务说明共 ${buffer.length} 字节，这里只有开头 ${end} 字节。往下读：${readCall(itemId, "brief", end)}）`;
}

// The end of the body, from a line start when one falls in the first half of the budget.
// Returns the section header line too, so the omission is stated before the text.
export function bodyTail(itemId: number, body: string): { header: string; text: string } {
  const buffer = Buffer.from(body, "utf8");
  if (buffer.length <= BODY_TAIL_BYTES) return { header: "--- 正文（里程碑摘要）---", text: body };
  let start = charStart(buffer, buffer.length - BODY_TAIL_BYTES);
  const newline = buffer.indexOf(0x0a, start);
  if (newline !== -1 && newline + 1 <= start + BODY_TAIL_BYTES / 2) start = newline + 1;
  return {
    header: `--- 正文（里程碑摘要，共 ${buffer.length} 字节，这里是最后 ${buffer.length - start} 字节，`
      + `也就是最新的部分。从头读：${readCall(itemId, "body", 0)}）---`,
    text: buffer.subarray(start).toString("utf8"),
  };
}

// One page of the brief or the body, at most SECTION_PAGE_BYTES of text plus two header lines.
export function sectionPage(itemId: number, section: TicketTextSection, text: string, offset: number): string {
  const name = SECTION_NAME[section];
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length === 0) return `#${itemId} 的${name}为空。`;
  if (!Number.isInteger(offset) || offset < 0 || offset >= buffer.length) {
    throw new Error(`offset ${offset} is outside the ${section} of item #${itemId} (0 to ${buffer.length - 1} bytes)`);
  }
  // An offset inside a character starts at that character.
  const start = charStart(buffer, offset);
  let end = buffer.length;
  if (end - start > SECTION_PAGE_BYTES) {
    end = charStart(buffer, start + SECTION_PAGE_BYTES);
    const newline = buffer.lastIndexOf(0x0a, end - 1);
    if (newline >= start + SECTION_PAGE_BYTES / 2) end = newline + 1;
  }
  const eof = end >= buffer.length;
  return [
    `#${itemId} 的${name}：第 ${start}–${end} 字节，共 ${buffer.length} 字节${eof ? "，已读完" : ""}`,
    eof ? null : `往下读：${readCall(itemId, section, end)}`,
    "",
    buffer.subarray(start, end).toString("utf8"),
  ].filter((line) => line !== null).join("\n");
}
