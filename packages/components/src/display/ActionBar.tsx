import type { ReactNode } from 'react';

import { Button, IconButton, type ButtonTone } from '../controls/Button';
import { useBreakpoint } from '../platform';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';

export type ActionBarButton = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: ButtonTone;
  testID?: string;
};

export type ActionBarProps = {
  /** 下一步要做的事，例如「你验收，并选好代码怎么处理」。一行，超出用省略号。 */
  next?: string;
  /** 下一步前面的引导词。 */
  nextLabel?: string;
  /** 下一步下面的一行小字，例如「已确认 1/3 条验收标准」。 */
  caption?: string;
  /** 「更多」按钮。label 是它的无障碍名称，写明里面有什么，例如「更多操作：取消工单」。 */
  more?: { label: string; onPress: () => void; testID?: string };
  /** 次要操作：白底描边按钮。 */
  secondary?: ActionBarButton;
  /** 主操作：实底按钮。 */
  primary?: ActionBarButton;
  /** 换成确认内容（ConfirmBar）。给了以后不显示下一步和按钮，确认完或取消后由调用方去掉。 */
  confirm?: ReactNode;
  /**
   * inline：文字和按钮在一行（桌面的侧滑栏）。stacked：文字在上，按钮在下面排满一行、44 高（手机，第四轮画板 D4-phone）。
   * auto：窗口比平板窄时用 stacked。
   */
  layout?: 'auto' | 'inline' | 'stacked';
  testID?: string;
};

// 底部操作栏（第四轮画板，和对话坞放在同一个外框里：ChatDock 的 bar）：左边是下一步和一行小字，右边是更多、次要和主按钮。
// 按钮能不能点由调用方给：组件不判断。
export function ActionBar({
  next, nextLabel = '下一步：', caption, more, secondary, primary, confirm, layout = 'auto', testID,
}: ActionBarProps) {
  const { tablet } = useBreakpoint();
  if (confirm) return <Column testID={testID}>{confirm}</Column>;
  const text = (
    <>
      {next ? (
        <Text size="card-title" weight="bold" numberOfLines={layout === 'stacked' || (layout === 'auto' && !tablet) ? 2 : 1}>
          <Text tone="secondary">{nextLabel}</Text>
          {next}
        </Text>
      ) : null}
      {caption ? <Text mt="text-stack" size="note" tone="secondary" numberOfLines={1}>{caption}</Text> : null}
    </>
  );
  if (layout === 'stacked' || (layout === 'auto' && !tablet)) {
    // 手机上按钮排满一行：主按钮比次要按钮宽一些。
    return (
      <Column testID={testID} px="card" pt="card" pb="card">
        {text}
        {more || secondary || primary ? (
          <Row mt="card-section" gap="actions" items="center">
            {more ? <IconButton icon="more" label={more.label} onPress={more.onPress} variant="outline" size="lg" testID={more.testID} /> : null}
            {secondary ? (
              <Box flex={1} minW={0}>
                <Button
                  label={secondary.label}
                  onPress={secondary.onPress}
                  disabled={secondary.disabled}
                  variant="outline"
                  tone={secondary.tone ?? 'neutral'}
                  size="lg"
                  fullWidth
                  testID={secondary.testID}
                />
              </Box>
            ) : null}
            {primary ? (
              <Box flex={1.4} minW={0}>
                <Button
                  label={primary.label}
                  onPress={primary.onPress}
                  disabled={primary.disabled}
                  variant="solid"
                  tone={primary.tone ?? 'accent'}
                  size="lg"
                  fullWidth
                  testID={primary.testID}
                />
              </Box>
            ) : null}
          </Row>
        ) : null}
      </Column>
    );
  }
  return (
    <Row testID={testID} items="center" gap="actions" px="card" pt="card" pb="card">
      <Column flex={1} minW={0}>{text}</Column>
      {more ? (
        <IconButton icon="more" label={more.label} onPress={more.onPress} variant="outline" size="md" testID={more.testID} />
      ) : null}
      {secondary ? (
        <Button
          label={secondary.label}
          onPress={secondary.onPress}
          disabled={secondary.disabled}
          variant="outline"
          tone={secondary.tone ?? 'neutral'}
          size="md"
          testID={secondary.testID}
        />
      ) : null}
      {primary ? (
        <Button
          label={primary.label}
          onPress={primary.onPress}
          disabled={primary.disabled}
          variant="solid"
          tone={primary.tone ?? 'accent'}
          size="md"
          testID={primary.testID}
        />
      ) : null}
    </Row>
  );
}
