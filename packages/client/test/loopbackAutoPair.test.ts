import { describe, expect, it } from 'vitest';

import {
  resolveLoopbackAutoPairEndpoint,
  shouldReplaceLoopbackCredentials,
  shouldUpgradeLoopbackCredentials,
} from '../src/loopbackAutoPair.ts';

const loopbackCredentials = {
  baseUrl: 'http://127.0.0.1:47130',
  accessToken: 'stale-secret',
  binding: {
    id: 7,
    kind: 'companion' as const,
    name: 'localhost-web',
    scopes: ['chat' as const],
  },
  lastSeq: 0,
};

describe('loopback auto-pair startup', () => {
  it('uses the local daemon only for a web app served from loopback', () => {
    expect(resolveLoopbackAutoPairEndpoint({
      platform: 'web',
      appOrigin: 'http://localhost:8081',
    })).toBe('http://127.0.0.1:47130');

    expect(resolveLoopbackAutoPairEndpoint({
      platform: 'web',
      appOrigin: 'http://127.0.0.1:8081',
      configuredEndpoint: 'http://localhost:47130/',
    })).toBe('http://localhost:47130');

    expect(resolveLoopbackAutoPairEndpoint({
      platform: 'ios',
      appOrigin: 'http://localhost:8081',
    })).toBeNull();
    expect(resolveLoopbackAutoPairEndpoint({
      platform: 'web',
      appOrigin: 'https://app.example.com',
    })).toBeNull();
    expect(resolveLoopbackAutoPairEndpoint({
      platform: 'web',
      appOrigin: 'http://localhost:8081',
      configuredEndpoint: 'https://daemon.example.com',
    })).toBeNull();
  });

  it('uses the page origin when the daemon gateway serves the web app', () => {
    expect(resolveLoopbackAutoPairEndpoint({
      platform: 'web',
      appOrigin: 'http://localhost:47135',
      servedByGateway: true,
    })).toBe('http://localhost:47135');

    expect(resolveLoopbackAutoPairEndpoint({
      platform: 'web',
      appOrigin: 'http://127.0.0.1:47135',
      configuredEndpoint: 'http://127.0.0.1:47140',
      servedByGateway: true,
    })).toBe('http://127.0.0.1:47140');

    expect(resolveLoopbackAutoPairEndpoint({
      platform: 'web',
      appOrigin: 'http://192.168.1.5:47130',
      servedByGateway: true,
    })).toBeNull();

    expect(resolveLoopbackAutoPairEndpoint({
      platform: 'ios',
      appOrigin: 'http://localhost:47135',
      servedByGateway: true,
    })).toBeNull();
  });

  it('replaces stored credentials when the local web UI should use a loopback daemon', () => {
    expect(shouldReplaceLoopbackCredentials(
      loopbackCredentials,
      'http://localhost:47140/',
    )).toBe(true);

    expect(shouldReplaceLoopbackCredentials(
      loopbackCredentials,
      'http://localhost:47130/',
    )).toBe(false);

    expect(shouldReplaceLoopbackCredentials(
      { ...loopbackCredentials, baseUrl: 'https://lead.example.test' },
      'http://127.0.0.1:47140',
    )).toBe(false);
  });

  // 网关按凭证的来历去掉 approvals:respond（plc pair new、本机兑换的邀请）：本机网页换一张回环凭证。
  it('upgrades a loopback credential that cannot decide, only on the same loopback daemon', () => {
    expect(shouldUpgradeLoopbackCredentials(loopbackCredentials, 'http://localhost:47130/')).toBe(true);
    expect(shouldUpgradeLoopbackCredentials({
      ...loopbackCredentials,
      binding: { ...loopbackCredentials.binding, scopes: ['chat', 'approvals:respond'] },
    }, 'http://127.0.0.1:47130')).toBe(false);
    expect(shouldUpgradeLoopbackCredentials(loopbackCredentials, null)).toBe(false);
    expect(shouldUpgradeLoopbackCredentials(loopbackCredentials, 'http://127.0.0.1:47140')).toBe(false);
    expect(shouldUpgradeLoopbackCredentials({
      ...loopbackCredentials,
      baseUrl: 'http://192.168.1.5:47130',
    }, 'http://127.0.0.1:47130')).toBe(false);
  });
});
