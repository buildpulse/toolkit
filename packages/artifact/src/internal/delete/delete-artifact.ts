import * as core from '@actions/core'
import { S3ArtifactManager } from '../s3/artifact-manager'
import { getArtifactManager } from '../shared/util'
import { DeleteArtifactResponse } from '../shared/interfaces'
import { retry } from '../shared/retry'
import { ArtifactNotFoundError } from '../shared/errors'

/**
 * Deletes an artifact from S3 storage
 * @param artifactId the ID of the artifact being deleted
 * @param options options for deleting the artifact
 */
export async function deleteArtifact(
  artifactId: string,
  options?: { failIfNotFound?: boolean }
): Promise<DeleteArtifactResponse> {
  const artifactManager = getArtifactManager()

  try {
    const result = await retry(
      () => artifactManager.deleteArtifact(artifactId),
      {
        retryableErrors: ['Temporary failure', 'timeout']
      }
    )
    core.info(`Artifact with ID ${artifactId} deleted`)
    return result
  } catch (error) {
    core.debug(`Failed to delete artifact ${artifactId}: ${error}`)
    if (error instanceof ArtifactNotFoundError && !options?.failIfNotFound) {
      return { id: parseInt(artifactId) }
    }
    throw error
  }
}
