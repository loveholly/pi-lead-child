import { styled, type GetProps, type TamaguiElement } from '@tamagui/core';

import { openURL, safeLink } from '../platform';
import { withDensity } from '../theme/density';
import { Text, TextFrame } from './Text';

const LinkFrame = styled(TextFrame, {
  displayName: 'Link',
  tone: 'accent',
  textDecorationLine: 'underline',
  cursor: 'pointer',
});

const LinkText = withDensity<GetProps<typeof LinkFrame>, TamaguiElement>(LinkFrame, { text: true, displayName: 'Link' });

export type LinkProps = Omit<GetProps<typeof LinkFrame>, 'onPress' | 'role'> & {
  href: string;
  /** always：一直有下划线。hover：悬停时才有（GitHub 正文里的链接，2026-10-16）。 */
  underline?: 'always' | 'hover';
};

// 文字链接。可以单独用，也可以嵌在 Text 里组成富文本。
// 只打开 http(s)、mailto 和 tel 链接；别的协议按普通文字显示，不可点击。
export function Link({ href, underline = 'always', ...rest }: LinkProps) {
  const safe = safeLink(href);
  if (!safe) return <Text {...rest} />;
  return (
    <LinkText
      role="link"
      onPress={() => openURL(safe)}
      {...(underline === 'hover' ? { textDecorationLine: { default: 'none', hover: 'underline' } } as const : {})}
      {...rest}
    />
  );
}

// 行内代码。和正文同一行，等宽字体，浅灰底的小圆角块（GitHub 的样式，2026-10-16）。
// 原生上嵌在 Text 里的文字不支持内边距和圆角，只有底色。
const CodeFrame = styled(TextFrame, {
  displayName: 'Code',
  mono: true,
  tone: 'default',
  bg: 'surface-muted',
  rounded: 'xs',
  px: 5,
  py: 1,
});

export type CodeProps = GetProps<typeof CodeFrame>;
export const Code = withDensity<CodeProps, TamaguiElement>(CodeFrame, { text: true, displayName: 'Code' });
