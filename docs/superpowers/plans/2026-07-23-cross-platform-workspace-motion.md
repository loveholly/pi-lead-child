# Cross-Platform Workspace Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add shared Reanimated panel and rail-view transitions to Android, iOS, and Web.

**Architecture:** A focused workspace motion module exports full-screen panel and keyed rail-content transition components. Both workbench variants and the shared rail consume these components, so animation behavior and parameters remain identical across platforms.

**Tech Stack:** React 19, React Native 0.86, Expo 57, React Native Reanimated 4.5, Vitest

---

### Task 1: Specify Shared Motion Behavior

**Files:**
- Create: `apps/companion/src/features/workspace/workspaceMotion.test.ts`
- Modify: `apps/companion/src/navigation/nativeNavigation.test.ts`

- [ ] Add failing tests for panel wrappers, rail transitions, and tab direction.
- [ ] Run the focused tests and confirm they fail because the motion module is absent.

### Task 2: Implement Reanimated Motion Components

**Files:**
- Create: `apps/companion/src/features/workspace/WorkspaceMotion.tsx`
- Modify: `apps/companion/src/features/workspace/Workbench.tsx`
- Modify: `apps/companion/src/features/workspace/Workbench.web.tsx`
- Modify: `apps/companion/src/features/workspace/WorkRail.tsx`

- [ ] Implement reduced-motion-aware left/right panel transitions.
- [ ] Implement ordered task/project/agenda content transitions.
- [ ] Replace immediate panel and content mounting with the shared motion components.
- [ ] Run focused tests and confirm they pass.

### Task 3: Verify All Platforms

**Files:**
- Verify only

- [ ] Run the full companion test suite.
- [ ] Run TypeScript and ESLint checks.
- [ ] Export Android, iOS, and Web bundles.
- [ ] Confirm Metro serves the updated bundle without runtime compilation errors.
