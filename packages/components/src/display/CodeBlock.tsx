import { useEffect, useRef, useState } from 'react';

import { IconButton } from '../controls/Button';
import { canCopyText, copyText } from '../platform';
import { Box, Column, Row } from '../primitives/layout';
import { ScrollArea } from '../primitives/ScrollArea';
import { Text } from '../primitives/Text';

export type CodeBlockProps = {
  code: string;
  /** 围栏上写的语言，例如 ts、diff。diff 按行着色。 */
  language?: string | null;
  testID?: string;
};

type DiffLine = 'add' | 'del' | 'hunk' | 'meta' | 'context';

function diffLineKind(line: string): DiffLine {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  return 'context';
}

const DIFF_STYLE = {
  add: { bg: 'success-wash', tone: 'success-dark' },
  del: { bg: 'danger-wash', tone: 'danger-dark' },
  hunk: { bg: 'accent-wash', tone: 'secondary' },
  meta: { bg: undefined, tone: 'secondary' },
  context: { bg: undefined, tone: 'default' },
} as const;

// 代码块（2026-10-16，GitHub 的样式；2026-10-17 加一条细边，和第四版的消息样式一致）：浅灰底、细边、圆角，
// 右上角是复制按钮；长行在块里横向滚动，不撑宽页面。
// diff 按行着色：+ 行绿、- 行红、@@ 行淡蓝，和 GitHub 一样。
export function CodeBlock({ code, language, testID }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (reset.current) clearTimeout(reset.current);
  }, []);
  const copy = async () => {
    if (!(await copyText(code))) return;
    setCopied(true);
    if (reset.current) clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopied(false), 1600);
  };
  const diff = language?.toLowerCase() === 'diff';
  const lines = code.split('\n');
  return (
    <Column testID={testID} w="100%" bg="surface-subtle" borderWidth={1} borderColor="border-soft" rounded="md" overflow="hidden">
      {/* spacing-exempt: 代码块头部按钮的留白 */}
      <Row items="center" gap="inline-item" pl="card" pr={4} minH={32} borderBottomWidth={1} borderBottomColor="border-soft">
        <Text flex={1} minW={0} size="meta" mono weight="semibold" tone="muted" numberOfLines={1}>{language ?? ''}</Text>
        {canCopyText ? (
          <IconButton icon={copied ? 'check' : 'copy'} label={copied ? '已复制' : '复制代码'} onPress={() => void copy()} variant="ghost" size="xs" />
        ) : null}
      </Row>
      <ScrollArea testID={testID ? `${testID}-scroll` : undefined} horizontal flex={0} showsScrollIndicator>
        <Column py="inset-y" minW="100%">
          {diff ? lines.map((line, index) => {
            const kind = diffLineKind(line);
            const style = DIFF_STYLE[kind];
            return (
              <Box
                key={`${index}-${line}`}
                testID={kind === 'add' || kind === 'del' ? `code-diff-${kind}` : undefined}
                bg={style.bg}
                px="inset-x"
                minW="100%"
              >
                <Text size="code" mono tone={style.tone}>{line || ' '}</Text>
              </Box>
            );
          }) : (
            <Box px="inset-x">
              <Text size="code" mono>{code}</Text>
            </Box>
          )}
        </Column>
      </ScrollArea>
    </Column>
  );
}
