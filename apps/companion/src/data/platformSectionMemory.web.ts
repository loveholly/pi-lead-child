import type { SectionMemoryStorage } from './platformSectionMemory';

// 工单详情里你手动展开或折叠过的块（工单详情 spec 4.0）：记在这台设备的 localStorage 里，不进后端。
// 没有 localStorage 的环境（隐私模式拒绝访问等）退回内存。
const KEY = 'pi-lead-child.ticket-detail-sections.v1';
let fallback: string | null = null;

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const platformSectionMemory: SectionMemoryStorage = {
  async load() {
    return local()?.getItem(KEY) ?? fallback;
  },
  async save(value) {
    const storage = local();
    if (storage) storage.setItem(KEY, value);
    else fallback = value;
  },
};
