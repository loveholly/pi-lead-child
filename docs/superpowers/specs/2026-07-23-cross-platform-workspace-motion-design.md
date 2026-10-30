# Cross-Platform Workspace Motion Design

## Goal

Use `react-native-reanimated` to give the workspace panels consistent motion on Android, iOS, and Web without introducing platform-specific implementations.

## Behavior

- The task/project/agenda rail enters from the left and exits to the left.
- The selected ticket thread enters from the right and exits to the right.
- Switching between task, project, and agenda views uses a short directional horizontal transition based on tab order.
- Motion follows the operating system reduced-motion preference.
- Existing routing, data loading, selection, and close behavior remain unchanged.

## Architecture

Create shared motion components in the workspace feature. `WorkspacePanel` owns full-screen panel entering and exiting transitions. `RailViewTransition` owns keyed content transitions inside `WorkRail`. Both native and web workbenches consume the same components and animation definitions.

## Verification

- Source-boundary tests assert that native and web workbenches use `WorkspacePanel` and that `WorkRail` uses `RailViewTransition`.
- Unit tests cover view ordering and transition direction.
- TypeScript, ESLint, and Expo exports validate Android, iOS, and Web compatibility.
