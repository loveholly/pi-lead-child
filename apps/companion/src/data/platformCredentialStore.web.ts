import { createJsonCredentialStore, type KeyValueStorage } from '@pi-lead-child/client';

const fallback = new Map<string, string>();
const webStorage: KeyValueStorage = {
  async getItem(key) {
    if (typeof localStorage === 'undefined') return fallback.get(key) ?? null;
    return localStorage.getItem(key);
  },
  async setItem(key, value) {
    if (typeof localStorage === 'undefined') fallback.set(key, value);
    else localStorage.setItem(key, value);
  },
  async removeItem(key) {
    if (typeof localStorage === 'undefined') fallback.delete(key);
    else localStorage.removeItem(key);
  },
};

export const platformCredentialStore = createJsonCredentialStore(webStorage);
