// 统一 diff（GitHub 的 get_diff 给的机器文本）的解析：每个文件在哪一边有哪些行。
// review 的评论只能落在 diff 里的行上（spec D5），新代码那一边（RIGHT）的行也算读过的内容，出处可以引用它们。

export interface DiffLine {
  path: string;
  side: "RIGHT" | "LEFT";
  line: number;
  text: string;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 解析统一 diff。按 hunk 头里的行数读 hunk，所以内容以「--- 」「+++ 」开头的行不会被当成文件头。
 * 认不出的行跳过。删掉的文件（+++ /dev/null）用旧路径。
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldPath: string | null = null;
  let path: string | null = null;
  let left = 0;
  let right = 0;
  // 这个 hunk 还剩几行旧的、几行新的。都是 0 时不在 hunk 里。
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      // 「\ No newline at end of file」不是 diff 的行。
      if (raw.startsWith("\\")) continue;
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === "+" && newLeft > 0) {
        lines.push({ path: path!, side: "RIGHT", line: right, text });
        right += 1;
        newLeft -= 1;
        continue;
      }
      if (marker === "-" && oldLeft > 0) {
        lines.push({ path: path!, side: "LEFT", line: left, text });
        left += 1;
        oldLeft -= 1;
        continue;
      }
      if (marker === " " && oldLeft > 0 && newLeft > 0) {
        lines.push({ path: path!, side: "RIGHT", line: right, text });
        lines.push({ path: path!, side: "LEFT", line: left, text });
        right += 1;
        left += 1;
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      // 行数对不上：这个 hunk 到此为止，按普通行继续认。
      oldLeft = 0;
      newLeft = 0;
    }
    if (raw.startsWith("diff --git ")) {
      path = null;
      oldPath = null;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const name = raw.slice(4).trim();
      oldPath = name === "/dev/null" ? null : name.replace(/^a\//, "");
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const name = raw.slice(4).trim();
      path = name === "/dev/null" ? oldPath : name.replace(/^b\//, "");
      continue;
    }
    const hunk = HUNK.exec(raw);
    if (hunk && path !== null) {
      left = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      right = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
    }
  }
  return lines;
}
