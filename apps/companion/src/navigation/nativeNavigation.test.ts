// @ts-ignore Vitest executes this source-boundary test in Node.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('renders the four persistent destinations with Expo Router Native Tabs', () => {
    const tabsLayout = source('../app/(tabs)/_layout.tsx');
    const rootTabs = source('./RootTabs.native.tsx');

    expect(tabsLayout).toContain("import RootTabs from '@/navigation/RootTabs'");
    expect(rootTabs).toContain("from 'expo-router/unstable-native-tabs'");
    expect(rootTabs).toContain('<NativeTabs');
    expect(rootTabs).not.toContain('<Slot');
    expect(rootTabs).not.toContain('Platform.OS');
    expect(rootTabs).not.toContain(' hidden');
    expect(rootTabs).toContain('labelVisibilityMode="labeled"');
    expect(rootTabs.match(/<NativeTabs\.Trigger name=/g)).toHaveLength(4);
    for (const routeName of ['index', 'tickets', 'projects', 'agenda']) {
      expect(rootTabs).toContain(`name="${routeName}"`);
    }
    expect(rootTabs.match(/<NativeTabs\.Trigger\.Icon\b/g)).toHaveLength(4);
    expect(rootTabs.match(/\bmd=/g)).toHaveLength(4);
    expect(rootTabs.match(/<NativeTabs\.Trigger\.Label>/g)).toHaveLength(4);
  });

  it('uses the workspace ticket projection for native grouping, filters, and empty states', () => {
    const ticketsRoute = source('../app/(tabs)/tickets.tsx');

    expect(ticketsRoute).toContain('TICKET_RAIL_FILTERS');
    expect(ticketsRoute).toContain('useWorkspaceStore');
    expect(ticketsRoute).toContain('<TicketList items={items} onSelect=');
    expect(ticketsRoute).toContain('grouped');
    expect(ticketsRoute).toContain('filter={ticketFilter}');
    expect(ticketsRoute).toContain("const loading = phase === 'loading' || phase === 'connecting'");
    expect(ticketsRoute).toContain('loading={loading}');
    expect(ticketsRoute).toContain('onCreateTask={openConversation}');
    expect(ticketsRoute).toContain('onClearFilters={clearFilters}');
    expect(ticketsRoute).toContain('onSeedTask={openConversation}');
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
    expect(webWorkbench).toContain('if (desktop) openThread()');
    expect(webWorkbench).toContain("openCompactPanel('thread')");
    expect(webWorkbench).toContain('setTicketReturnDestination(compactDestination)');
  });

  it('shows an explicit not-found state for an invalid ticket deep link', () => {
    const ticketRoute = source('../app/ticket/[id].tsx');

    expect(ticketRoute).toContain('resolveWorkspaceTicket');
    expect(ticketRoute).toContain('useWorkItems');
    expect(ticketRoute).not.toContain('resolveWorkspaceTickets');
    expect(ticketRoute).toContain('未找到工单');
    expect(ticketRoute).toContain('返回');
  });
});
