import * as core from '@actions/core'
import { S3ArtifactManager } from '../s3/artifact-manager'
import { getS3Config } from '../shared/config'
import { DeleteArtifactResponse } from '../shared/interfaces'

/**
 * Deletes an artifact from S3 storage
 * @param artifactId the ID of the artifact being deleted
 * @param options options for deleting the artifact
 */
export async function deleteArtifact(
  artifactId: string,
  options?: { failIfNotFound?: boolean }
): Promise<DeleteArtifactResponse> {
  const s3Config = getS3Config()
  const artifactManager = new S3ArtifactManager(s3Config)

  try {
    const result = await artifactManager.deleteArtifact(`artifacts/${artifactId}`)
    core.info(`Artifact with ID ${artifactId} deleted`)
    return {
      id: parseInt(artifactId)
    }
  } catch (error) {
    if (options?.failIfNotFound) {
      throw error
    }
    // Log but don't fail if artifact not found and failIfNotFound is false
    core.debug(`Failed to delete artifact ${artifactId}: ${error}`)
    return {
      id: parseInt(artifactId)
    }
  }
}
