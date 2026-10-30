import { describe, expect, it } from 'vitest';

import { icons } from '../src';

// 图标表的每一行都要同时给出 iOS 和 Android/web 的名字，少一个时那个平台上图标是空的。
describe('icon table', () => {
  it('names every icon on both platforms', () => {
    for (const [name, icon] of Object.entries(icons)) {
      expect.soft(icon.ios, `${name} ios`).toMatch(/\S/);
      expect.soft(icon.android, `${name} android`).toMatch(/\S/);
    }
  });

  it('has the settings icons', () => {
    expect(icons.settings).toEqual({ ios: 'gearshape', android: 'settings' });
    expect(icons.link).toEqual({ ios: 'link', android: 'link' });
    expect(icons.device).toEqual({ ios: 'iphone', android: 'smartphone' });
    expect(icons.devices).toEqual({ ios: 'laptopcomputer.and.iphone', android: 'devices' });
  });
});
