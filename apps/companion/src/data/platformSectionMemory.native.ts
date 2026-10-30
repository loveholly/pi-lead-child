import { File, Paths } from 'expo-file-system';

import type { SectionMemoryStorage } from './platformSectionMemory';

// 工单详情里你手动展开或折叠过的块（工单详情 spec 4.0）：存在应用文档目录的一个小文件里，不进后端。
const memoryFile = () => new File(Paths.document, 'ticket-detail-sections.json');

export const platformSectionMemory: SectionMemoryStorage = {
  async load() {
    const file = memoryFile();
    return file.exists ? file.text() : null;
  },
  async save(value) {
    const file = memoryFile();
    if (!file.exists) file.create();
    file.write(value);
  },
};
