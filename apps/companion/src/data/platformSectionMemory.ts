// 兜底实现：Metro 在 iOS/Android 上选 .native.ts，在 web 上选 .web.ts。
// 这个文件只给类型检查和 node 测试用，只存在内存里。
export type SectionMemoryStorage = {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
};

let value: string | null = null;

export const platformSectionMemory: SectionMemoryStorage = {
  async load() { return value; },
  async save(next) { value = next; },
};
