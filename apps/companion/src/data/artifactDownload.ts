import type { ArtifactPresentationPayload } from './artifactDownload.types';

export type { ArtifactPresentationPayload } from './artifactDownload.types';

export async function presentArtifactDownload(
  _payload: ArtifactPresentationPayload,
  _signal?: AbortSignal,
): Promise<void> {
  throw new Error('artifact presentation is unavailable on this platform');
}
