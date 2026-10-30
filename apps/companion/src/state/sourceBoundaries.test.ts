// @ts-ignore Vitest executes source-boundary checks in Node.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Companion state source boundaries', () => {
  it('has no legacy ControlPlane facade or production demo workspace entities', () => {
    const facade = new URL('../data/ControlPlaneProvider.tsx', import.meta.url);
    const model = readFileSync(new URL('../features/workspace/model.ts', import.meta.url), 'utf8');

    expect(existsSync(facade)).toBe(false);
    expect(model).not.toMatch(/export const (tickets|timeline|projects|agendaEvents)\b/);
    expect(model).not.toContain('initialWorkspaceState');
  });
});
