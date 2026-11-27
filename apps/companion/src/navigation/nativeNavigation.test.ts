// @ts-ignore Vitest executes this source-boundary test in Node.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createWorkspaceStore } from '../state/workspace/store';

const source = (relativePath: string) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('native workspace navigation', () => {
  it('keeps platform-specific files at shell and adapter boundaries', () => {
    const featuresRoot = new URL('../features/', import.meta.url);
    const featureFiles = readdirSync(featuresRoot, { recursive: true }) as string[];
    const platformFeatureFiles = featureFiles
      .filter((file) => /\.(?:native|web)\.tsx?$/.test(file))
      .sort();

    expect(platformFeatureFiles).toEqual(['workspace/Workbench.web.tsx']);
  });

  // 2026-11-14 方案 F（主题 11.20 H-1）：原生上没有底部标签栏。会话是首页，工单、项目、日程从抽屉进，用栈打开。
  it('opens the destinations through a stack without a tab bar, entered from the home drawer', () => {
    const tabsLayout = source('../app/(tabs)/_layout.tsx');
    const rootTabs = source('./RootTabs.native.tsx');
    const drawer = source('../features/home/HomeDrawer.tsx');

    expect(tabsLayout).toContain("import RootTabs from '@/navigation/RootTabs'");
    expect(rootTabs).not.toContain('unstable-native-tabs');
    expect(rootTabs).toContain('<Stack');
    for (const routeName of ['index', 'tickets', 'projects', 'agenda']) {
      expect(rootTabs).toContain(`name="${routeName}"`);
    }
    for (const href of ["'/tickets'", "'/projects'", "'/agenda'", "'/views'", "'/settings'"]) {
      expect(drawer).toContain(href);
    }
  });

  it('groups the native ticket page from the workspace ticket projection', () => {
    const ticketsRoute = source('../app/(tabs)/tickets.tsx');
    const groups = source('../features/workspace/TicketGroups.tsx');

    expect(ticketsRoute).toContain('resolveWorkspaceTickets(');
    expect(ticketsRoute).toContain('<TicketGroups items={items} onSelect=');
    for (const group of ['ticket-group-waiting', 'ticket-group-running', 'ticket-group-ended']) {
      expect(groups).toContain(group);
    }
  });

  it('keeps native conversation in the Lead tab and opens work through native routes', () => {
    const workbench = source('../features/workspace/Workbench.tsx');
    expect(workbench).toContain('useRouter');
    expect(workbench).toContain("router.push('/tickets')");
    expect(workbench).not.toContain('<ConnectedWorkRail');
    expect(workbench).not.toContain('<ConnectedTicketThread');
  });

  it('keeps animated workspace panels on web while native navigation owns screen transitions', () => {
    const webWorkbench = source('../features/workspace/Workbench.web.tsx');
    const nativeWorkbench = source('../features/workspace/Workbench.tsx');
    const motionUrl = new URL('../features/workspace/WorkspaceMotion.tsx', import.meta.url);

    // 面板动效由组件库的 SlidePanel 提供（Reanimated，三端相同），应用里不再有自己的动效模块。
    expect(existsSync(motionUrl)).toBe(false);
    expect(webWorkbench).toContain('<SlidePanel edge="left"');
    expect(webWorkbench).toContain('<SlidePanel edge="right"');
    expect(nativeWorkbench).not.toContain('<SlidePanel');
  });

  it('animates task, project, and agenda changes through the shared transition', () => {
    const workRail = source('../features/workspace/WorkRail.tsx');
    expect(workRail).toContain('<SwitchTransition transitionKey={view} direction={viewDirection}>');
  });

  it('animates the desktop session layout when side panels change width', () => {
    const webWorkbench = source('../features/workspace/Workbench.web.tsx');

    expect(webWorkbench).toContain('<LayoutTransition testID="workspace-session"');
    // The desktop opens the ticket detail through the store's showTicket (#590): it opens the thread, which changes the
    // session column's width that LayoutTransition animates; when the detail already shows the ticket, it flashes.
    expect(webWorkbench).toContain('if (desktop) showTicket(Number(ticketId))');
    expect(webWorkbench).toContain("openCompactPanel('thread')");
    expect(webWorkbench).toContain('setTicketReturnDestination(compactDestination)');
    const store = createWorkspaceStore();
    store.getState().showTicket(66);
    expect(store.getState()).toMatchObject({ selectedTicketId: 66, threadOpen: true, viewsOpen: false, topicOpenId: null });
  });

  it('shows an explicit not-found state for an invalid ticket deep link', () => {
    const ticketRoute = source('../app/ticket/[id].tsx');

    expect(ticketRoute).toContain('resolveWorkspaceTicket');
    expect(ticketRoute).toContain('useWorkItems');
    expect(ticketRoute).not.toContain('resolveWorkspaceTickets');
    expect(ticketRoute).toContain('m.notFound(');
    expect(ticketRoute).toContain('ticket-not-found-back');
  });
});
