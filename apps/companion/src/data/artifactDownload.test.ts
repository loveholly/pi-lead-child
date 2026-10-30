import { afterEach, describe, expect, it, vi } from 'vitest';

import { presentArtifactDownload } from './artifactDownload.web';

const originalDocument = globalThis.document;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe('artifact presentation', () => {
  it('clicks a temporary web download and always removes and revokes it', async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const appendChild = vi.fn();
    const anchor = { href: '', download: '', style: { display: '' }, click, remove };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: vi.fn(() => anchor), body: { appendChild } },
    });
    URL.createObjectURL = vi.fn(() => 'blob:artifact');
    URL.revokeObjectURL = vi.fn();

    await presentArtifactDownload({
      artifactId: 9,
      bytes: new Uint8Array([1, 2, 3]).buffer,
      filename: 'report.txt',
      mediaType: 'text/plain',
      byteLength: 3,
      sha256: 'a'.repeat(64),
    });

    expect(anchor.download).toBe('report.txt');
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:artifact');
  });

  it('does not create browser objects after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    URL.createObjectURL = vi.fn();

    await expect(presentArtifactDownload({
      artifactId: 9,
      bytes: new ArrayBuffer(0),
      filename: 'report.txt',
      mediaType: 'text/plain',
      byteLength: 0,
      sha256: 'a'.repeat(64),
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
