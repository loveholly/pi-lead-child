import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import {
  ArtifactPresentationError,
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
  const filename = safeArtifactFilename(payload.filename, payload.artifactId);
  const file = new File(Paths.cache, `lead-child-${payload.artifactId}-${filename}`);
  try {
    file.create({ overwrite: true });
    file.write(new Uint8Array(payload.bytes));
    throwIfArtifactDownloadAborted(signal);
    if (!await Sharing.isAvailableAsync()) {
      throw new ArtifactPresentationError('system sharing is unavailable');
    }
    await Sharing.shareAsync(file.uri, {
      mimeType: payload.mediaType,
      dialogTitle: filename,
    });
    throwIfArtifactDownloadAborted(signal);
  } finally {
    if (file.exists) file.delete();
  }
}
