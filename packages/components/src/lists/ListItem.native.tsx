import { Host, List as ExpoList, ListItem as ExpoListItem, RNHostView, Text as ExpoText } from '@expo/ui';
import { createContext, useContext } from 'react';
import { View } from 'react-native';

import { fontFaces, palette } from '../theme/tokens';
import type { ListItemProps, ListProps } from './ListItem.types';

export type { ListItemProps, ListProps } from './ListItem.types';

// 原生实现：iOS 上是 SwiftUI List，Android 上是 Compose 的列表项（Expo UI）。
// 前导、尾随和额外内容是 React Native 视图，用 RNHostView 嵌进原生列表。
// Expo UI 的控件必须放在 Host 里：在 List 里时由 List 提供，单独使用时 ListItem 自己包一层。
const InsideList = createContext(false);

export function List({ children, testID }: ListProps) {
  return (
    <Host matchContents={{ vertical: true }} seedColor={palette.accent} style={{ alignSelf: 'stretch' }}>
      <ExpoList testID={testID}>
        <InsideList.Provider value>{children}</InsideList.Provider>
      </ExpoList>
    </Host>
  );
}

export function ListItem(props: ListItemProps) {
  const insideList = useContext(InsideList);
  if (insideList) return <NativeListItem {...props} />;
  return (
    <Host matchContents={{ vertical: true }} seedColor={palette.accent} style={{ alignSelf: 'stretch' }}>
      <NativeListItem {...props} />
    </Host>
  );
}

function NativeListItem({
  title, subtitle, subtitleLines = 1, leading, trailing, footer, onPress, selected = false, mono = false, testID,
}: ListItemProps) {
  return (
    <ExpoListItem
      testID={testID}
      onPress={onPress}
      leading={leading ? <RNHostView matchContents><View>{leading}</View></RNHostView> : undefined}
      trailing={trailing ? <RNHostView matchContents><View>{trailing}</View></RNHostView> : undefined}
    >
      <ExpoText
        numberOfLines={1}
        textStyle={{
          fontFamily: selected ? fontFaces.extrabold : mono ? fontFaces['mono-bold'] : fontFaces.regular,
          fontSize: mono ? 12.5 : 13,
          color: selected ? palette.accent : palette.text,
        }}
      >
        {title}
      </ExpoText>
      {subtitle || footer ? (
        <ExpoListItem.Supporting>
          {subtitle ? (
            <ExpoText numberOfLines={subtitleLines} textStyle={{ fontFamily: fontFaces.regular, fontSize: 11, color: palette['text-muted'] }}>
              {subtitle}
            </ExpoText>
          ) : null}
          {footer ? <RNHostView matchContents={{ vertical: true }}><View>{footer}</View></RNHostView> : null}
        </ExpoListItem.Supporting>
      ) : null}
    </ExpoListItem>
  );
}
