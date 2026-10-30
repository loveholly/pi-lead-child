// @ts-ignore Vitest executes this source-boundary test in Node.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

// 这些界面用哪个组件库，由 src/uiBoundary.test.ts 统一检查。这里只检查它们的接线。
describe('shared Companion surfaces', () => {
  it('wires the pairing surfaces to the runtime and the camera', () => {
    const pair = source('../app/pair.tsx');
    const paired = source('../features/settings/PairedDeviceStatus.tsx');
    const scanner = source('./PairingScanner.tsx');

    expect.soft(pair).toContain('<TextField');
    expect.soft(pair).toContain('runtime.pair(endpoint, code)');
    expect.soft(pair).toContain('runtime.pairSocket(uri)');
    // 已配对的状态和移除凭证在 PairedDeviceStatus 里，配对页和设置的「本设备」共用它。
    expect.soft(pair).toContain('<PairedDeviceStatus />');
    expect.soft(paired).toContain('runtime.forget()');
    expect.soft(pair).toContain('<PairingScanner');
    expect.soft(pair).toContain('router.back()');
    expect.soft(pair).toContain('onPress={submitting ? undefined : () => setScannerOpen(true)}');

    expect.soft(scanner).toContain('useCameraPermissions()');
    expect.soft(scanner).toContain('requestPermission()');
    expect.soft(scanner).toContain('<CameraView');
    expect.soft(scanner).toContain('onScanned(result.data)');
  });

  it('wires the shared identity and the standalone ticket page to navigation', () => {
    const identity = source('./LeadIdentity.tsx');
    const detail = source('../app/ticket/[id].tsx');

    // 已经配对时打开设置的「本设备」，还没配对时打开配对页（leadIdentityRouting.test.tsx 按两种状态渲染）。
    expect.soft(identity).toContain("isDevicePaired(phase) ? '/settings/device' : '/pair'");
    expect.soft(identity).toContain('router.push(target as Href)');
    // 名字来自设置里的名字（缺省 Paimon），不写死。头像换成了 Lead 的形象（方案 C，主题 F-7），状态和左栏头部同一份（leadFairy），
    // 来源由 useLeadAvatarSource 决定（FairyEye 只在隐藏开关开着时出现）。
    expect.soft(identity).toContain('useLeadName()');
    expect.soft(identity).toContain('<LeadAvatar');
    expect.soft(identity).toContain('useLeadAvatarSource(fairy)');
    expect.soft(identity).not.toContain('<FairyEye');
    expect.soft(identity).toContain('leadFairy(presence');
    expect.soft(identity).not.toContain('Paimon');
    expect.soft(identity).toContain('lead-status-dot');
    expect.soft(identity).not.toContain('控制面 · 已连接');

    expect.soft(detail).toContain('router.back()');
    expect.soft(detail).toContain("pathname: '/ticket/[id]'");
  });

  it('keeps independent ticket, project, and agenda pages dense instead of card based', () => {
    const tickets = source('../app/(tabs)/tickets.tsx');
    const projects = source('../app/(tabs)/projects.tsx');
    const agenda = source('../app/(tabs)/agenda.tsx');

    expect.soft(tickets).toContain('<TicketList items={items} onSelect=');
    expect.soft(projects).toContain("overviews={phase === 'ready' ? overviews : null}");
    expect.soft(agenda).toContain("timeline={phase === 'ready' ? timeline : null}");

    for (const screen of [tickets, projects, agenda]) {
      expect.soft(screen).not.toMatch(/\bcards(?:=|\s|\/>)/);
    }
  });
});
