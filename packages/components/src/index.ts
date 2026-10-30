// @pi-lead-child/components 的公开 API。应用只从这里引用 UI。
//
// 组件分两类：
// - Tamagui 组件（布局、文字、卡片、徽章等）：三个平台都由 Tamagui 渲染，接受 Tamagui 的样式属性。
// - 原生控件（Button、IconButton、TextField、Switch、SegmentedControl、List/ListItem）：
//   web 上由 Tamagui 渲染，iOS 和 Android 上是 SwiftUI / Jetpack Compose 控件（Expo UI）。
//   每个控件的各平台实现满足同一份 props 类型（见 *.types.ts）。

// 根组件、字体和设计 token
export { UIProvider, UIServerStyles } from './provider/UIProvider';
export { Density } from './provider/Density';
export { DesignPreferencesProvider } from './provider/DesignPreferencesProvider';
export { DEFAULT_PREFERENCES as DEFAULT_DESIGN_PREFERENCES, contrastRatio, designColorOverrides, useDesignPreferences } from './theme/preferences';
export type { DensityZone, DesignPreferences, LineHeightLevel, PaletteRole, RadiusLevel, TextScaleLevel } from './theme/preferences';
export { useUIFonts } from './theme/fonts';
export { breakpoints, densities, fontFaces, fontSizes, measure, palette, radius, space, spacing, spacingByDensity, textLeading, textSizes, textSizesByDensity } from './theme/tokens';
export type { ColorToken, Density as DensityName, FontFace, FontSizeToken, RadiusToken, SpacingToken } from './theme/tokens';

// 平台
export { ActivityBoundary, subscribeUserActivity } from './activity';
export {
  appInForeground, canCopyText, copyText, isAndroid, isIOS, isWeb, openURL, platformOS, safeLink, subscribeAppForeground, useBreakpoint,
} from './platform';
export type { Breakpoint } from './platform';

// 布局和文字
export { Box, Column, Divider, Row, Spacer } from './primitives/layout';
export type { BoxProps, ColumnProps, DividerProps, RowProps, SpacerProps } from './primitives/layout';
export { Text } from './primitives/Text';
export type { TextProps, TextTone, TextWeight } from './primitives/Text';
export { Code, Link } from './primitives/Link';
export type { CodeProps, LinkProps } from './primitives/Link';
export { Pressable } from './primitives/Pressable';
export type { PressableProps } from './primitives/Pressable';
export { ScrollArea } from './primitives/ScrollArea';
export type { ScrollAreaHandle, ScrollAreaProps, ScrollEvent } from './primitives/ScrollArea';
export { KeyboardArea, Screen } from './primitives/Screen';
export type { KeyboardAreaProps, ScreenProps } from './primitives/Screen';

// 展示
export { ChatScroll } from './display/ChatScroll';
export type { ChatScrollProps } from './display/ChatScroll';
export {
  chatFollowOnContent, chatFollowOnScroll, chatFollowToBottom, chatReflowAnchor, INITIAL_CHAT_FOLLOW, isNearBottom, nextStick,
  PRESSED_ANCHOR_MS, STICK_THRESHOLD_PX,
} from './display/stickToBottom';
export type { ChatFollow, ChatReflowAnchor, ChatScrollMove } from './display/stickToBottom';
export { Avatar } from './display/Avatar';
export type { AvatarProps, AvatarTone } from './display/Avatar';
export { Badge } from './display/Badge';
export type { BadgeProps, BadgeTone, BadgeVariant } from './display/Badge';
export { Card, Skeleton } from './display/Card';
export { ChatDock } from './display/ChatDock';
export type { ChatDockProps } from './display/ChatDock';
export type { CardProps, SkeletonProps } from './display/Card';
export { Dot } from './display/Dot';
export type { DotProps } from './display/Dot';
export { DockedLayout } from './display/DockedLayout';
export type { DockedLayoutProps } from './display/DockedLayout';
export { EmptyState } from './display/EmptyState';
export type { EmptyStateProps } from './display/EmptyState';
export { Icon } from './display/Icon';
export { FairyEye } from './display/FairyEye';
export type { FairyEyeProps, FairyEyeState, FairyEyeTone } from './display/FairyEye';
export { AvatarImage } from './display/AvatarImage';
export type { AvatarImageProps } from './display/AvatarImage';
export { LeadAvatar } from './display/LeadAvatar';
export type { LeadAvatarProps, LeadAvatarSource } from './display/LeadAvatar';
export { FairyMark } from './display/FairyMark';
export type { FairyMarkProps } from './display/FairyMark';
export type { IconProps, IconWeight } from './display/Icon';
export { icons } from './display/icons';
export type { IconName } from './display/icons';
export { ImageThumbnail } from './display/ImageThumbnail';
export type { ImageThumbnailProps } from './display/ImageThumbnail';
export { MessageBubble } from './display/MessageBubble';
export type { MessageBubbleProps } from './display/MessageBubble';
export { CodeBlock } from './display/CodeBlock';
export type { CodeBlockProps } from './display/CodeBlock';
export { DataTable } from './display/DataTable';
export type { DataTableProps } from './display/DataTable';
export { estimatedTextWidth, isNumericColumn, tableColumnWidth } from './display/tableLayout';
export { TaskCheckbox } from './display/TaskCheckbox';
export type { TaskCheckboxProps } from './display/TaskCheckbox';
export { ConversationColumn } from './display/ConversationColumn';
export type { ConversationColumnProps } from './display/ConversationColumn';
export { NoticeRow } from './display/NoticeRow';
export { Absence, AbsenceTail } from './display/Absence';
export type { AbsenceAction, AbsenceDetail, AbsenceProps, AbsenceTailProps } from './display/Absence';
export { SystemLine } from './display/SystemLine';
export { Group, GroupList } from './display/Group';
export type { GroupEntry, GroupProps } from './display/Group';
export { Annotation, AnnotationConfirm } from './display/Annotation';
export { emphasizeNumbers, RecordBlock, RecordLine, RecordTag } from './display/RecordBlock';
export type { RecordBlockProps, RecordLineProps, RecordTagProps } from './display/RecordBlock';
export type { AnnotationConfirmProps, AnnotationDetail, AnnotationProps } from './display/Annotation';
export type { SystemLineProps } from './display/SystemLine';
export type { NoticeRowProps, NoticeTone } from './display/NoticeRow';
export { Popover } from './display/Popover';
export type { PopoverProps } from './display/Popover';
export { AnchoredPanel } from './display/AnchoredPanel';
export type { AnchoredPanelProps } from './display/AnchoredPanel';
export { ProgressBar } from './display/ProgressBar';
export type { ProgressBarProps } from './display/ProgressBar';
export { Section } from './display/Section';
export { DetailHeader } from './display/DetailHeader';
export type { DetailHeaderProps } from './display/DetailHeader';
export type { SectionProps } from './display/Section';
export { Sheet } from './display/Sheet';
export type { SheetProps } from './display/Sheet';
export { ActionBar } from './display/ActionBar';
export type { ActionBarButton, ActionBarProps } from './display/ActionBar';
export { ConfirmBar } from './display/ConfirmBar';
export type { ConfirmBarProps } from './display/ConfirmBar';
export { QrCode, qrDarkRuns } from './display/QrCode';
export type { QrCodeProps, QrRun } from './display/QrCode';
export { Spinner } from './display/Spinner';
export type { SpinnerProps } from './display/Spinner';
export { ServiceMark } from './display/ServiceMark';
export type { ServiceMarkProps, ServiceMarkService, ServiceMarkSize } from './display/ServiceMark';
export { TaskCard } from './display/TaskCard';
export type {
  TaskCardNote, TaskCardProps, TaskCardStatus, TaskCardStep, TaskCardTool, TaskStepState,
} from './display/TaskCard';

// 数据：工单详情和聊天里的生成式界面（genui）共用。只收普通的 props，不认识 genui 的卡片结构。
export { formatNumber, withUnit } from './data/format';
export { dataToneBadge, dataToneFill, dataToneText } from './data/tones';
export type { DataTone } from './data/tones';
export { Stats } from './data/Stats';
export type { StatItem, StatsProps } from './data/Stats';
export { Steps } from './data/Steps';
export type { StepItem, StepState, StepsProps } from './data/Steps';
export { Progress } from './data/Progress';
export type { ProgressProps } from './data/Progress';
export { Timeline } from './data/Timeline';
export type { TimelineItem, TimelineProps } from './data/Timeline';
export { BarChart } from './data/BarChart';
export type { BarChartBar, BarChartProps } from './data/BarChart';
export { FactList } from './data/FactList';
export type { FactAction, FactItem, FactListProps } from './data/FactList';
export { OptionPills } from './controls/OptionPills';
export type { OptionPill, OptionPillsProps } from './controls/OptionPills';
export { Tile } from './data/Tile';
export type { TileEmphasis, TileProps } from './data/Tile';
export { MediaRow } from './data/MediaRow';
export type { MediaRowProps } from './data/MediaRow';
export { Segments } from './data/Segments';
export type { SegmentItem, SegmentsProps } from './data/Segments';
export { QuotedMessages } from './data/QuotedMessages';
export type { QuotedMessage, QuotedMessagesProps } from './data/QuotedMessages';
export { Checklist } from './data/Checklist';
export type { ChecklistColumn, ChecklistItem, ChecklistProps, ChecklistVerdict } from './data/Checklist';

// 控件
export { Button, IconButton } from './controls/Button';
export type { ButtonProps, ButtonSize, ButtonTone, ButtonVariant, IconButtonProps } from './controls/Button';
export { ChatInput } from './controls/ChatInput';
export type { ChatInputProps } from './controls/ChatInput';
export { Chip } from './controls/Chip';
export type { ChipProps } from './controls/Chip';
export { ChoiceGroup } from './controls/ChoiceGroup';
export type { ChoiceGroupProps, ChoiceOption } from './controls/ChoiceGroup';
export { SegmentedControl } from './controls/SegmentedControl';
export type { SegmentedControlProps, SegmentedOption } from './controls/SegmentedControl';
export { Switch } from './controls/Switch';
export type { SwitchProps } from './controls/Switch';
export { TextField } from './controls/TextField';
export type { TextFieldProps, TextFieldSize, TextFieldVariant } from './controls/TextField';

// 列表
export { List, ListItem } from './lists/ListItem';
export type { ListItemProps, ListProps } from './lists/ListItem';
export { RecordRow } from './lists/RecordRow';
export type { RecordRowProps } from './lists/RecordRow';

// 动效
export { Grow, growTimings } from './motion/Grow';
export type { GrowProps } from './motion/Grow';
export { LayoutTransition, SlidePanel, SwitchTransition } from './motion/Motion';
export type { LayoutTransitionProps, MotionLayout, SlidePanelProps, SwitchTransitionProps } from './motion/Motion';
