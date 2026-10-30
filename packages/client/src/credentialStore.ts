import type { BindingDto } from '@pi-lead-child/protocol';

export interface ControlPlaneCredentials {
  baseUrl: string;
  accessToken: string;
  binding: BindingDto;
  lastSeq: number;
}

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface CredentialStore {
  load(): Promise<ControlPlaneCredentials | null>;
  save(credentials: ControlPlaneCredentials): Promise<void>;
  clear(): Promise<void>;
}

const CREDENTIAL_KEY = 'pi-lead-child.control-plane.v2';

function isCredentials(value: unknown): value is ControlPlaneCredentials {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ControlPlaneCredentials>;
  return typeof record.baseUrl === 'string' &&
    typeof record.accessToken === 'string' &&
    Number.isInteger(record.lastSeq) && Number(record.lastSeq) >= 0 &&
    !!record.binding && typeof record.binding.id === 'number' &&
    typeof record.binding.kind === 'string' && typeof record.binding.name === 'string' &&
    Array.isArray(record.binding.scopes);
}

export function createJsonCredentialStore(
  storage: KeyValueStorage,
  key = CREDENTIAL_KEY,
): CredentialStore {
  return {
    async load() {
      const raw = await storage.getItem(key);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (isCredentials(parsed)) return parsed;
      } catch {
        // Corrupt credentials are cleared below rather than repeatedly breaking startup.
      }
      await storage.removeItem(key);
      return null;
    },
    save(credentials) {
      return storage.setItem(key, JSON.stringify(credentials));
    },
    clear() {
      return storage.removeItem(key);
    },
  };
}
