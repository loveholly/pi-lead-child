import * as SecureStore from 'expo-secure-store';

import { createJsonCredentialStore, type KeyValueStorage } from '@pi-lead-child/client';

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const secureStorage: KeyValueStorage = {
  getItem(key) { return SecureStore.getItemAsync(key, options); },
  setItem(key, value) { return SecureStore.setItemAsync(key, value, options); },
  removeItem(key) { return SecureStore.deleteItemAsync(key, options); },
};

export const platformCredentialStore = createJsonCredentialStore(secureStorage);
