import * as Crypto from 'expo-crypto';

// 网关客户端需要的安全随机数和 SHA-256。React Native 没有 WebCrypto，所以由 expo-crypto 提供；
// 有 WebCrypto 的地方（web）摘要直接用它。客户端包本身不依赖任何平台模块，见 @pi-lead-child/client。
export function platformRandomBytes(length: number): Promise<Uint8Array> {
  return Crypto.getRandomBytesAsync(length);
}

export function platformSha256(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
}
