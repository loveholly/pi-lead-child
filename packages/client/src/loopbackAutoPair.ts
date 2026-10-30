import { normalizeControlPlaneEndpoint } from './controlPlaneClient.ts';
import type { ControlPlaneCredentials } from './credentialStore.ts';

interface LoopbackAutoPairEnvironment {
  platform: string;
  appOrigin: string | null;
  configuredEndpoint?: string;
  // `npm run build:web` exports the app for the daemon gateway, which serves it next to its API.
  servedByGateway?: boolean;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.');
}

function isSameLoopbackEndpoint(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(normalizeControlPlaneEndpoint(left));
    const rightUrl = new URL(normalizeControlPlaneEndpoint(right));
    return isLoopbackHostname(leftUrl.hostname) &&
      isLoopbackHostname(rightUrl.hostname) &&
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.port === rightUrl.port &&
      leftUrl.pathname === rightUrl.pathname;
  } catch {
    return false;
  }
}

function isExplicitCredentialFailure(reason: unknown): boolean {
  if (!reason || typeof reason !== 'object') return false;
  const status = 'status' in reason ? Number(reason.status) : undefined;
  const code = 'code' in reason ? String(reason.code) : '';
  return status === 401 || code === 'not_paired';
}

export function shouldRecoverLoopbackCredentials(
  credentials: ControlPlaneCredentials,
  loopbackEndpoint: string | null | undefined,
  failures: readonly unknown[],
): boolean {
  return Boolean(loopbackEndpoint) &&
    isSameLoopbackEndpoint(credentials.baseUrl, loopbackEndpoint!) &&
    failures.some(isExplicitCredentialFailure);
}

export function shouldReplaceLoopbackCredentials(
  credentials: ControlPlaneCredentials,
  loopbackEndpoint: string | null | undefined,
): boolean {
  if (!loopbackEndpoint) return false;
  try {
    const storedUrl = new URL(normalizeControlPlaneEndpoint(credentials.baseUrl));
    const configuredUrl = new URL(normalizeControlPlaneEndpoint(loopbackEndpoint));
    if (!isLoopbackHostname(configuredUrl.hostname)) return false;
    if (!isLoopbackHostname(storedUrl.hostname)) return false;
    return !isSameLoopbackEndpoint(credentials.baseUrl, loopbackEndpoint);
  } catch {
    return false;
  }
}

export function resolveLoopbackAutoPairEndpoint({
  platform,
  appOrigin,
  configuredEndpoint,
  servedByGateway = false,
}: LoopbackAutoPairEnvironment): string | null {
  if (platform !== 'web' || !appOrigin) return null;
  try {
    const appUrl = new URL(appOrigin);
    if (!isLoopbackHostname(appUrl.hostname)) return null;
    const endpoint = normalizeControlPlaneEndpoint(
      configuredEndpoint ?? (servedByGateway ? appUrl.origin : 'http://127.0.0.1:47130'),
    );
    if (!isLoopbackHostname(new URL(endpoint).hostname)) return null;
    return endpoint;
  } catch {
    return null;
  }
}
