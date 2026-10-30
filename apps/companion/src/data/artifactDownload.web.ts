import {
  safeArtifactFilename,
  throwIfArtifactDownloadAborted,
  type ArtifactPresentationPayload,
} from './artifactDownload.types';

export type { ArtifactPresentationPayload } from './artifactDownload.types';

export async function presentArtifactDownload(
  payload: ArtifactPresentationPayload,
  signal?: AbortSignal,
): Promise<void> {
  throwIfArtifactDownloadAborted(signal);
  const blob = new Blob([payload.bytes], { type: payload.mediaType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeArtifactFilename(payload.filename, payload.artifactId);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try {
    throwIfArtifactDownloadAborted(signal);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
