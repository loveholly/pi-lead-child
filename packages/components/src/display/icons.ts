// 图标表：一个语义名对应 iOS 的 SF Symbol 和 Android/web 的 Material Symbol。
// 应用只写语义名，不关心平台上的具体图标。新增图标时在这里加一行。
export const icons = {
  chat: { ios: 'bubble.left.and.bubble.right', android: 'forum' },
  inbox: { ios: 'tray', android: 'inbox' },
  tickets: { ios: 'rectangle.stack', android: 'view_agenda' },
  folder: { ios: 'folder', android: 'folder' },
  calendar: { ios: 'calendar', android: 'calendar_month' },
  refresh: { ios: 'arrow.clockwise', android: 'refresh' },
  check: { ios: 'checkmark', android: 'check' },
  search: { ios: 'magnifyingglass', android: 'search' },
  'arrow-right': { ios: 'arrow.right', android: 'arrow_forward' },
  'arrow-up': { ios: 'arrow.up', android: 'arrow_upward' },
  'arrow-down': { ios: 'arrow.down', android: 'arrow_downward' },
  'arrow-up-right': { ios: 'arrow.up.right', android: 'north_east' },
  reply: { ios: 'arrow.turn.down.right', android: 'subdirectory_arrow_right' },
  back: { ios: 'chevron.left', android: 'arrow_back' },
  close: { ios: 'xmark', android: 'close' },
  'chevron-right': { ios: 'chevron.right', android: 'chevron_right' },
  // 和 chevron-right 成对（表格两边的滚动提示）。back 在 Android 和网页上是箭头，不是尖角。
  'chevron-left': { ios: 'chevron.left', android: 'chevron_left' },
  'chevron-down': { ios: 'chevron.down', android: 'expand_more' },
  'chevron-up': { ios: 'chevron.up', android: 'expand_less' },
  // 更多操作（三个点）：工单详情底部操作栏的「更多」。
  more: { ios: 'ellipsis', android: 'more_horiz' },
  camera: { ios: 'camera.fill', android: 'photo_camera' },
  'qr-scan': { ios: 'qrcode.viewfinder', android: 'qr_code_scanner' },
  copy: { ios: 'doc.on.doc', android: 'content_copy' },
  document: { ios: 'doc.text', android: 'description' },
  // 数据来源（会话里回复下面的「依据」标签）。
  database: { ios: 'cylinder', android: 'database' },
  exclamation: { ios: 'exclamationmark', android: 'priority_high' },
  approval: { ios: 'exclamationmark', android: 'approval' },
  warning: { ios: 'exclamationmark.triangle.fill', android: 'warning' },
  error: { ios: 'exclamationmark.octagon.fill', android: 'error' },
  verified: { ios: 'checkmark.seal.fill', android: 'verified' },
  shield: { ios: 'shield', android: 'shield' },
  'shield-check': { ios: 'checkmark.shield.fill', android: 'verified_user' },
  'circle-fill': { ios: 'circle.fill', android: 'circle' },
  progress: { ios: 'arrow.trianglehead.2.clockwise.rotate.90', android: 'progress_activity' },
  agent: { ios: 'doc.text', android: 'smart_toy' },
  ticket: { ios: 'doc.text', android: 'confirmation_number' },
  'approval-request': { ios: 'doc.text', android: 'approval' },
  clock: { ios: 'clock', android: 'schedule' },
  // Fairy 的标记（墨色圆角方块里一个白色四角星，主题 default.md 第 12 节）。
  sparkle: { ios: 'sparkle', android: 'auto_awesome' },
  // 没有回答（缺席占位，主题 11.7）。
  'no-reply': { ios: 'exclamationmark.bubble', android: 'chat_error' },
  // 回复说到一半被打断（缺席占位的接尾）。
  interrupted: { ios: 'waveform.path.ecg', android: 'show_chart' },
  // 别的凭证做的操作（系统信息行，主题 11.6）。
  key: { ios: 'key', android: 'key' },
  // 记录块里来源的小图标（主题 11.8）：Slack 频道、GitHub。
  hash: { ios: 'number', android: 'tag' },
  branch: { ios: 'arrow.triangle.branch', android: 'call_split' },
  offline: { ios: 'icloud.slash', android: 'cloud_off' },
  'error-outline': { ios: 'exclamationmark.circle', android: 'error_outline' },
  mic: { ios: 'mic', android: 'mic' },
  plus: { ios: 'plus', android: 'add' },
  split: { ios: 'rectangle.split.2x1', android: 'view_sidebar' },
  sidebar: { ios: 'sidebar.left', android: 'view_sidebar' },
  // 自定义视图（会话顶栏最右边的入口，主题 11.14）。
  views: { ios: 'square.grid.2x2', android: 'dashboard' },
  // 设置页：入口的齿轮和各分组的图标。
  settings: { ios: 'gearshape', android: 'settings' },
  link: { ios: 'link', android: 'link' },
  device: { ios: 'iphone', android: 'smartphone' },
  devices: { ios: 'laptopcomputer.and.iphone', android: 'devices' },
  person: { ios: 'person.crop.circle', android: 'account_circle' },
} as const;

export type IconName = keyof typeof icons;
