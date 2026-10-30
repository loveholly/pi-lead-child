// Lead 的名字（设置 → 身份与风格，2026-10-22）。界面上凡是称呼 Lead 的地方都用它，不写死 Lead 或 Paimon。
//   - 组件用 useLeadName()：名字改了会重新渲染。
//   - 离组件很远的纯函数（拼提示文字的）用 leadNameNow()：它读最近一次取到的名字，下一次渲染时生效。
// 名字记在本机（网页的 localStorage），下次打开在连上 daemon 之前就用对的名字；读写不了时只用内存里的。
import { DEFAULT_LEAD_NAME, normalizeLeadName, LEAD_NAME_MAX_LENGTH } from '@pi-lead-child/protocol';

const STORAGE_KEY = 'plc.leadName';

function storage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function valid(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const clean = normalizeLeadName(name);
  return clean && [...clean].length <= LEAD_NAME_MAX_LENGTH ? clean : null;
}

function readStored(): string | null {
  try {
    return valid(storage()?.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

let current: string = readStored() ?? DEFAULT_LEAD_NAME;

/** 最近一次取到的名字。没取到过时是本机记下的，再没有就是缺省的 Paimon。 */
export function leadNameNow(): string {
  return current;
}

/** 取到新的名字时调（runtime 读到 /v1/lead/profile 以后）。 */
export function rememberLeadName(name: string): void {
  const clean = valid(name);
  if (!clean || clean === current) return;
  current = clean;
  try {
    storage()?.setItem(STORAGE_KEY, clean);
  } catch {
    // 本机存不了（隐私模式、配额）：只用内存里的。
  }
}
