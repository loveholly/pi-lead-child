// @ts-ignore Vitest executes source-boundary checks in Node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('compact workspace navigation', () => {
  it('uses one shared navigation component inside the full-screen compact workspace', () => {
    const navigation = source('./CompactWorkspaceNav.tsx');
    const workbench = source('./Workbench.web.tsx');

    expect(navigation).toContain('testID="compact-nav"');
    expect(navigation).toContain("id: 'conversation'");
    expect(navigation).toContain("id: 'tickets'");
    expect(navigation).toContain("id: 'projects'");
    expect(navigation).toContain("id: 'agenda'");
    expect(navigation).toContain("placement = 'bottom'");
    expect(workbench).toContain('<CompactWorkspaceNav');
    expect(workbench).toContain('placement="top"');
    expect(workbench).toContain("compactDestination === 'conversation'");
    expect(workbench).toContain("onOpenAll={() => selectCompactDestination('tickets')}");
    expect(workbench).toContain("view={compactDestination === 'inbox' ? 'inbox' : compactDestination === 'tickets' ? 'tickets' : compactDestination}");
  });

  it('preserves the previous destination while a compact ticket thread is open', () => {
    const workbench = source('./Workbench.web.tsx');

    expect(workbench).toContain('setTicketReturnDestination(compactDestination)');
    expect(workbench).toContain("setCompactDestination('tickets')");
    expect(workbench).toContain('setCompactDestination(ticketReturnDestination)');
  });
});
