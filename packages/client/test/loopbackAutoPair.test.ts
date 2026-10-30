import { describe, expect, it } from 'vitest';

import {
  resolveLoopbackAutoPairEndpoint,
  shouldReplaceLoopbackCredentials,
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
});
