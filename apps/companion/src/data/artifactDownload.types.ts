import type { ArtifactDownload } from '@pi-lead-child/client';

export interface ArtifactPresentationPayload extends ArtifactDownload {
  artifactId: number;
}

export class ArtifactPresentationError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = 'ArtifactPresentationError';
  }
}

export function throwIfArtifactDownloadAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('artifact download aborted');
  error.name = 'AbortError';
  throw error;
}

export function safeArtifactFilename(filename: string, artifactId: number): string {
  const safe = filename.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  return safe && safe !== '.' && safe !== '..' ? safe : `artifact-${artifactId}`;
}
