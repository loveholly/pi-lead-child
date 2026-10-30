import { describe, expect, it } from 'vitest';
// @ts-ignore Vitest executes this source-boundary test in Node.
import { readFileSync } from 'node:fs';

import * as workspaceModel from './model';

type ResolveRailViewDirection = (
  previous: 'tickets' | 'projects' | 'agenda',
  next: 'tickets' | 'projects' | 'agenda',
) => 'forward' | 'backward' | 'none';

const resolveRailViewDirection = (
  workspaceModel as unknown as Record<string, unknown>
).resolveRailViewDirection as ResolveRailViewDirection | undefined;

describe('workspace motion', () => {
  it('moves forward through task, project, and agenda views', () => {
    expect(resolveRailViewDirection).toBeTypeOf('function');
    expect(resolveRailViewDirection?.('tickets', 'projects')).toBe('forward');
    expect(resolveRailViewDirection?.('projects', 'agenda')).toBe('forward');
  });

  it('moves backward when returning to an earlier rail view', () => {
    expect(resolveRailViewDirection).toBeTypeOf('function');
    expect(resolveRailViewDirection?.('agenda', 'projects')).toBe('backward');
    expect(resolveRailViewDirection?.('projects', 'tickets')).toBe('backward');
  });

  it('does not animate when the selected view is unchanged', () => {
    expect(resolveRailViewDirection).toBeTypeOf('function');
    expect(resolveRailViewDirection?.('tickets', 'tickets')).toBe('none');
  });

  it('keeps the work rail at 300px and splits the rest between the session and the ticket panel', () => {
    const workbench = readFileSync(new URL('./Workbench.web.tsx', import.meta.url), 'utf8');

    // 工单详情复核 P2-6：侧栏固定 300，会话和工单面板平分其余宽度，工单面板最宽 640。
    // 尺寸作用在 SlidePanel/LayoutTransition 的动画容器上。
    expect(workbench).toContain('const RAIL_LAYOUT = { grow: 0, basis: 300, minWidth: 300, maxWidth: 300 };');
    expect(workbench).toContain('const SESSION_LAYOUT = { grow: 1, basis: 0, minWidth: 0 };');
    expect(workbench).toContain('const THREAD_LAYOUT = { grow: 1, basis: 0, minWidth: 0, maxWidth: 640 };');
    expect(workbench).toContain('<SlidePanel edge="left" {...RAIL_LAYOUT}');
    expect(workbench).toContain('<LayoutTransition testID="workspace-session" {...SESSION_LAYOUT}');
    expect(workbench).toContain('<SlidePanel edge="right" {...THREAD_LAYOUT}');
    expect(workbench).not.toMatch(/\bw=\{288\}/);
    expect(workbench).not.toMatch(/\bw=\{400\}/);
  });

  it('lets the desktop workbench fill the available viewport', () => {
    const workbench = readFileSync(new URL('./Workbench.web.tsx', import.meta.url), 'utf8');

    expect(workbench).not.toMatch(/maxW=\{1160\}/);
    expect(workbench).not.toMatch(/maxH=\{772\}/);
    expect(workbench).toMatch(/<Row\s+flex=\{1\}\s+w="100%"\s+h="100%"[^>]*rounded="4xl"/s);
  });

  it('keeps the root rail selection visible while a child thread is open', () => {
    const workbench = readFileSync(new URL('./Workbench.web.tsx', import.meta.url), 'utf8');

    expect(workbench).toContain('selectedTicketSummary?.parentTicketId ?? selectedTicketId');
    expect(workbench).toContain('selectedTicketId={railSelectedTicketId');
  });
});
