# @pi-lead-child/companion

Lead 工作台的 Expo 应用。同一份代码运行在 web、iOS 和 Android 上。web 版由 daemon 的网关托管。

## 目录

- `src/app/`：expo-router 的路由（文件即路由）。
- `src/features/`：工作台、会话和工单详情的视图。
- `src/components/`：几个跨页面的应用组件，例如 `StatusBadge`、`LeadIdentity`、`PairingScanner`。
- `src/state/`：zustand 状态、运行时和 hooks。
- `src/data/`：平台相关的数据适配（凭据存储、加密、产物下载）。
- `src/navigation/`：原生端的底部标签。

## 界面规则

界面只从 `@pi-lead-child/components` 引入：布局、文字、按钮、输入框、列表、图标、动效和主题都在组件库里。不要在应用里直接引入 react-native、Expo UI 或 Tamagui，也不要写样式表。`src/uiBoundary.test.ts` 检查这条规则。

## 命令

在仓库根目录运行：

```bash
npm run web
```

```bash
npm run test:companion
```

```bash
npm run typecheck:companion
```

```bash
npm run build:web
```

原生 bundle 的导出：

```bash
cd apps/companion && npx expo export --platform ios --output-dir dist-ios
```
