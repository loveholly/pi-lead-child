// @ts-ignore Vitest executes this source-boundary test in Node.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isDevicePaired, SETTINGS_GROUPS, settingsGroupLabel, settingsSectionForPath } from './settingsNav';

const appFile = (path: string) => new URL(`../../app/${path}`, import.meta.url);
const source = (path: string) => readFileSync(appFile(path), 'utf8');

// 设置页的路由（issue 06）。Expo Router 按文件建路由，所以这里检查文件和根栈的登记。
describe('settings routes', () => {
  it('has a file for every settings route', () => {
    for (const path of [
      'settings/_layout.tsx',
      'settings/index.tsx',
      'settings/connections/index.tsx',
      'settings/connections/[id].tsx',
      'settings/profile.tsx',
      'settings/channels.tsx',
      'settings/device.tsx',
      'settings/devices.tsx',
      'settings/standing-orders.tsx',
      'settings/runtimes.tsx',
    ]) {
      expect.soft(existsSync(appFile(path)), path).toBe(true);
    }
  });

  it('registers the settings stack in the root layout and keeps the pairing modal', () => {
    const root = source('_layout.tsx');
    expect(root).toContain('<Stack.Screen name="settings" />');
    expect(root).toContain('<Stack.Screen name="pair" options={{ presentation: \'modal\' }} />');
  });

  it('uses the sidebar shell on desktop and a stack on phones', () => {
    const layout = source('settings/_layout.tsx');
    expect(layout).toContain('<SettingsDesktopShell');
    expect(layout).toContain('<Slot />');
    expect(layout).toContain('<Stack screenOptions=');
  });

  it('points every sidebar entry at an existing route and has no entries for features that do not exist yet', () => {
    const items = SETTINGS_GROUPS.flatMap((group) => group.items);
    // Lead 分组在最上面（2026-10-22），第一项是「身份与风格」。
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual(['Lead', '账号', '设备', '执行']);
    expect(items.map((item) => item.label)).toEqual(['身份与风格', '外观', '模型', '记忆', '常设指令', '连接', '消息通道', '本设备', '已配对设备', '执行器']);
    // 消息通道在「账号」分组里，紧跟「连接」。
    expect(SETTINGS_GROUPS[1]!.items.map((item) => item.href)).toEqual(['/settings/connections', '/settings/channels']);
    for (const item of items) {
      const route = item.href.replace(/^\//, '');
      expect.soft(existsSync(appFile(`${route}.tsx`)) || existsSync(appFile(`${route}/index.tsx`)), item.href).toBe(true);
    }
  });
});

describe('settingsGroupLabel', () => {
  it('titles the Lead group with the name the user gave it', () => {
    const [lead, account] = SETTINGS_GROUPS;
    expect(settingsGroupLabel(lead!, 'Jarvis')).toBe('Jarvis');
    expect(settingsGroupLabel(account!, 'Jarvis')).toBe('账号');
  });
});

describe('settingsSectionForPath', () => {
  it('lands desktop on the first entry and shows the grouped list on phones', () => {
    expect(settingsSectionForPath('/settings', { desktop: true })).toBe('profile');
    expect(settingsSectionForPath('/settings', { desktop: false })).toBeNull();
  });

  it('maps each section path, including a connection detail', () => {
    for (const desktop of [true, false]) {
      expect(settingsSectionForPath('/settings/profile', { desktop })).toBe('profile');
      expect(settingsSectionForPath('/settings/connections', { desktop })).toBe('connections');
      expect(settingsSectionForPath('/settings/connections/jira', { desktop })).toBe('connections');
      expect(settingsSectionForPath('/settings/device', { desktop })).toBe('device');
      expect(settingsSectionForPath('/settings/devices', { desktop })).toBe('devices');
      expect(settingsSectionForPath('/settings/standing-orders', { desktop })).toBe('standing-orders');
      expect(settingsSectionForPath('/settings/runtimes', { desktop })).toBe('runtimes');
      expect(settingsSectionForPath('/settings/channels', { desktop })).toBe('channels');
    }
  });

  it('selects nothing outside settings', () => {
    expect(settingsSectionForPath('/', { desktop: true })).toBeNull();
    expect(settingsSectionForPath('/pair', { desktop: true })).toBeNull();
    expect(settingsSectionForPath('/settings/unknown', { desktop: true })).toBeNull();
  });
});

describe('isDevicePaired', () => {
  it('matches the pairing page: paired while connecting or ready', () => {
    expect(isDevicePaired('ready')).toBe(true);
    expect(isDevicePaired('connecting')).toBe(true);
    expect(isDevicePaired('unpaired')).toBe(false);
    expect(isDevicePaired('loading')).toBe(false);
    expect(isDevicePaired('error')).toBe(false);
  });
});
