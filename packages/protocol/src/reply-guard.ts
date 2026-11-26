// What the model writes must never carry the daemon's own markers into the conversation.
//
// Two markers are internal:
//   · NO_REPLY: the quiet word. A round with nothing to tell the user ends with it.
//   · The input envelopes (<system_event>, <user_message>, <untrusted_external_text>): the daemon writes them into the
//     model's input. A model that continues its own input writes a made-up next round after the quiet word.
//
// One function decides, so every place that shows model text (the live stream, the stored turn, the Slack reply, the
// ticket agent's stream, the client) cuts the same way. The rules look at position and structure, never at wording:
//   · A made-up envelope is a line that starts with an envelope tag (after optional quiet words) and sits outside a code
//     fence. That line and everything after it is dropped.
//   · NO_REPLY (also several in a row, like NO_REPLYNO_REPLY) is dropped at the end of the text, and at the start when it
//     stands alone on its line. In the middle of a sentence, in code, inside bold or quotes, or at the start of a
//     sentence ("NO_REPLY is the word ..."), it is the model talking about the word, so it stays.
// White space is kept as the model wrote it, except the white space next to what is dropped: messages of one round are
// joined as they always were.

const QUIET_WORD = "NO_REPLY";
const ENVELOPE_TAGS = ["system_event", "user_message", "untrusted_external_text"] as const;

const WORD = "A-Za-z0-9_";
const QUIET_PUNCTUATION = "[。．.!！]";
// One quiet word, then the end of the word: not a letter, digit or underscore, or the next quiet word straight away.
const QUIET_RUN = `(?:${QUIET_WORD}${QUIET_PUNCTUATION}?(?:(?=${QUIET_WORD})|(?![${WORD}]))\\s*)+`;

// A leading run counts only when the last word ends its line: "NO_REPLY\n..." is the quiet word, "NO_REPLY is ..." is a sentence.
const QUIET_WORD_ONE = `${QUIET_WORD}${QUIET_PUNCTUATION}?(?:(?=${QUIET_WORD})|(?![${WORD}]))`;
const LEADING_QUIET = new RegExp(`^\\s*(?:${QUIET_WORD_ONE}\\s*)*${QUIET_WORD_ONE}[ \\t]*(?:\\n\\s*|$)`, "iu");
// A trailing run must not start right after a letter, a digit, a code mark, a bold mark or a quote mark.
const TRAILING_QUIET = new RegExp(`\\s*(?<![${WORD}\`*"'“‘「])${QUIET_RUN}$`, "iu");

const TAG_NAMES = ENVELOPE_TAGS.join("|");
const FENCE_LINE = /^[ \t]*(?:```|~~~)/u;
// The sticky regex reads from the start of a line. The tag name must end there, so that <system_eventually> stays text.
// While the text still grows, the end of the text is not an end of the name (the next letter may still come).
const envelopeLine = (final: boolean) => new RegExp(
  `([ \\t]*(?:${QUIET_WORD}${QUIET_PUNCTUATION}?[ \\t]*)*)<\\/?(?:${TAG_NAMES})${final ? `(?![${WORD}])` : `(?=[^${WORD}])`}`,
  "iuy",
);
const ENVELOPE_LINE_FINAL = envelopeLine(true);
const ENVELOPE_LINE_GROWING = envelopeLine(false);

// Where the made-up envelope starts (the index of its "<"), or -1.
function findEnvelopeCut(text: string, final: boolean): number {
  const pattern = final ? ENVELOPE_LINE_FINAL : ENVELOPE_LINE_GROWING;
  let inFence = false;
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      pattern.lastIndex = start;
      const match = pattern.exec(text);
      if (match) return start + match[1]!.length;
    }
    if (newline === -1) break;
    start = newline + 1;
  }
  return -1;
}

export interface SanitizedReply {
  text: string;
  // Nothing is left for the user to read.
  silent: boolean;
  // A made-up envelope was cut off.
  forged: boolean;
}

export function sanitizeLeadReply(raw: string): SanitizedReply {
  const cut = findEnvelopeCut(raw, true);
  const forged = cut >= 0;
  const kept = forged ? raw.slice(0, cut).trimEnd() : raw;
  const body = kept.replace(LEADING_QUIET, "").replace(TRAILING_QUIET, "");
  const silent = body.trim() === "";
  return { text: silent ? "" : body, silent, forged };
}

// Only the envelope cut, for text that was stored before the cut existed (the client uses it).
export function stripForgedEnvelopes(raw: string): string {
  const cut = findEnvelopeCut(raw, true);
  return cut < 0 ? raw : raw.slice(0, cut).trimEnd();
}

export function hasForgedEnvelope(raw: string): boolean {
  return findEnvelopeCut(raw, true) >= 0;
}

// The end of the text that may still change when more text comes: a run of quiet words or the start of one,
// and a line that may become an envelope tag.
const PARTIAL_QUIET_TAIL = new RegExp(
  `(?:${QUIET_WORD}${QUIET_PUNCTUATION}?\\s*)*(?:NO_REPL|NO_REP|NO_RE|NO_R|NO_|NO|N)?\\s*$`, "iu",
);
const PARTIAL_ENVELOPE_LINE = new RegExp(
  `^[ \\t]*(?:${QUIET_WORD}${QUIET_PUNCTUATION}?[ \\t]*)*(<\\/?[a-z_]*)$`, "iu",
);

function heldFrom(text: string): number {
  let from = text.length - (PARTIAL_QUIET_TAIL.exec(text)?.[0].length ?? 0);
  const heldBefore = () => { while (from > 0 && /\s/u.test(text[from - 1]!)) from -= 1; };
  const lineStart = text.lastIndexOf("\n") + 1;
  const partial = PARTIAL_ENVELOPE_LINE.exec(text.slice(lineStart));
  if (partial) {
    const fragment = partial[1]!.toLowerCase();
    if (ENVELOPE_TAGS.some((tag) => `<${tag}`.startsWith(fragment) || `</${tag}`.startsWith(fragment))) {
      from = Math.min(from, lineStart);
      // If the envelope is confirmed, the quiet words before it are the end of the kept text and are dropped too.
      const before = TRAILING_QUIET.exec(text.slice(0, from));
      if (before) from = before.index;
    }
  }
  // White space right before what is held goes with it: it is dropped when the held text turns out to be a quiet word.
  heldBefore();
  return from;
}

export interface ReplyStreamGuard {
  // Text that may be shown now. Joined with end(), the pieces equal sanitizeLeadReply(whole text).text.
  push(delta: string): string;
  // The message is complete: the rest of the text. The counters below stay readable until the next push.
  end(): string;
  // A made-up envelope was found in this message.
  readonly forged: boolean;
  // Something was cut from this message: a made-up envelope or a quiet word (valid after end()).
  readonly removed: boolean;
  // How many characters were shown for this message.
  readonly emitted: number;
  // Nothing of the next message was shown yet: no push since the last end(), or nothing came out of the pushes.
  readonly atStart: boolean;
  // Text was pushed since the last end().
  readonly open: boolean;
}

// One guard for each assistant message. It holds back only the few characters that could still turn into a quiet word
// or an envelope tag, so the text of a normal answer streams without delay.
export function createReplyStreamGuard(): ReplyStreamGuard {
  let all = "";
  let shown = "";
  let forged = false;
  let removed = false;
  let finished = false;
  let open = false;

  const reset = () => {
    all = "";
    shown = "";
    forged = false;
    removed = false;
    finished = false;
    open = false;
  };

  const target = (final: boolean): string => {
    if (final) return sanitizeLeadReply(all).text;
    const cut = findEnvelopeCut(all, false);
    if (cut >= 0) return sanitizeLeadReply(all).text;
    const head = all.slice(0, heldFrom(all)).replace(LEADING_QUIET, "");
    // White space alone may still be dropped together with a quiet word that comes next.
    return head.trim() === "" ? "" : head;
  };

  const advance = (final: boolean): string => {
    if (!forged && findEnvelopeCut(all, false) >= 0) forged = true;
    const next = target(final);
    // The shown text is always a prefix of the target. If it is not, show nothing more instead of repeating text.
    const piece = next.startsWith(shown) ? next.slice(shown.length) : "";
    shown += piece;
    return piece;
  };

  return {
    push(delta) {
      if (finished) reset();
      all += delta;
      open = true;
      return advance(false);
    },
    end() {
      const piece = advance(true);
      forged = forged || hasForgedEnvelope(all);
      removed = forged || (all.trim() !== "" && sanitizeLeadReply(all).text !== all);
      finished = true;
      open = false;
      return piece;
    },
    get forged() { return forged; },
    get removed() { return removed; },
    get emitted() { return shown.length; },
    get atStart() { return finished || shown.length === 0; },
    get open() { return open; },
  };
}
