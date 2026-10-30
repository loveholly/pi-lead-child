# Lead-Child Companion High-Fidelity UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the approved Lead-Child assistant prototype as a production-shaped Expo application for iOS, Android, and web.

**Architecture:** Add an isolated Expo Router application under `apps/companion`. Web renders the approved conditional three-column workbench, while native platforms use Expo Router Native Tabs for Lead, tickets, projects, and agenda, plus a stack route for ticket detail. Shared feature components consume a pure local prototype model now and can later be connected to the paired gateway without redesigning the UI.

**Tech Stack:** Expo SDK 57, React Native 0.86, React 19.2, Expo Router Native Tabs, `@expo/ui`, React Native Unistyles 3, TypeScript, Vitest.

---

### Task 1: Scaffold and configuration

**Files:**
- Create: `apps/companion/package.json`
- Create: `apps/companion/app.json`
- Create: `apps/companion/index.ts`
- Create: `apps/companion/babel.config.js`
- Create: `apps/companion/tsconfig.json`
- Create: `apps/companion/src/unistyles.ts`

- [ ] Generate the Expo SDK 57 project.
- [ ] Install Expo Router, Expo UI, Unistyles 3, Nitro Modules, fonts, and testing dependencies.
- [ ] Configure the Unistyles Babel plugin and Expo Router custom entry.
- [ ] Configure typed routes, Metro web, and New Architecture builds.

### Task 2: Prototype state and selectors

**Files:**
- Create: `apps/companion/src/features/workspace/model.ts`
- Create: `apps/companion/src/features/workspace/model.test.ts`

- [ ] Write failing tests for ticket selection, conditional detail visibility, project grouping, and current-week agenda data.
- [ ] Run the tests and confirm the expected failures.
- [ ] Implement the minimal typed model and selectors.
- [ ] Run the tests and confirm they pass.

### Task 3: Design system and primitives

**Files:**
- Create: `apps/companion/src/design/tokens.ts`
- Create: `apps/companion/src/design/typography.ts`
- Create: `apps/companion/src/components/StatusBadge.tsx`
- Create: `apps/companion/src/components/LeadIdentity.tsx`
- Create: `apps/companion/src/components/NativeActionButton.tsx`

- [ ] Encode the extracted Plus Jakarta Sans, JetBrains Mono, cobalt, cool-paper, state colors, radii, and spacing tokens.
- [ ] Add reusable status, identity, and Expo UI action primitives.

### Task 4: Shared Lead conversation

**Files:**
- Create: `apps/companion/src/features/chat/LeadConversation.tsx`
- Create: `apps/companion/src/features/chat/MessageComposer.tsx`
- Create: `apps/companion/src/features/chat/EmbeddedTicketCard.tsx`
- Create: `apps/companion/src/features/chat/ToolCallRow.tsx`

- [ ] Implement the permanent Lead header, conversation transcript, task card, tool calls, running summary, and composer.
- [ ] Add local message submission and ticket opening interactions.

### Task 5: Work rail and ticket thread

**Files:**
- Create: `apps/companion/src/features/workspace/WorkRail.tsx`
- Create: `apps/companion/src/features/workspace/TicketList.tsx`
- Create: `apps/companion/src/features/workspace/ProjectList.tsx`
- Create: `apps/companion/src/features/workspace/AgendaWeek.tsx`
- Create: `apps/companion/src/features/tickets/TicketThread.tsx`
- Create: `apps/companion/src/features/tickets/TimelineRow.tsx`

- [ ] Implement task/project/agenda switching and filtering.
- [ ] Implement the conditional right thread with heartbeat, progress, timeline, and contextual composer.
- [ ] Preserve the `unknown` project bucket.

### Task 6: Web workbench

**Files:**
- Create: `apps/companion/src/features/workspace/Workbench.web.tsx`
- Create: `apps/companion/src/features/workspace/Workbench.native.tsx`

- [ ] Implement the desktop conditional three-column layout.
- [ ] Allow both side columns to close and reopen independently.
- [ ] Collapse to the Lead-first mobile/tablet experience below the desktop breakpoint.

### Task 7: Expo Router and native tabs

**Files:**
- Create: `apps/companion/src/app/_layout.tsx`
- Create: `apps/companion/src/app/(tabs)/_layout.tsx`
- Create: `apps/companion/src/navigation/RootTabs.native.tsx`
- Create: `apps/companion/src/navigation/RootTabs.web.tsx`
- Create: `apps/companion/src/app/(tabs)/index.tsx`
- Create: `apps/companion/src/app/(tabs)/tickets.tsx`
- Create: `apps/companion/src/app/(tabs)/projects.tsx`
- Create: `apps/companion/src/app/(tabs)/agenda.tsx`
- Create: `apps/companion/src/app/ticket/[id].tsx`

- [ ] Add platform-native tab bars on iOS and Android.
- [ ] Keep the web route as the full workbench.
- [ ] Add the native ticket-detail stack route.

### Task 8: Verification

**Files:**
- Modify only files required by failures discovered during verification.

- [ ] Run unit tests.
- [ ] Run TypeScript checking.
- [ ] Run Expo dependency validation.
- [ ] Export the web build.
- [ ] Start the web app and compare desktop and mobile screenshots to the supplied reference.
- [ ] Check browser console errors and horizontal overflow.

