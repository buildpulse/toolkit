import * as core from '@actions/core'
import {S3ArtifactManager} from '../s3/artifact-manager'
import {getS3Config} from '../shared/config'
import {GetArtifactResponse} from '../shared/interfaces'
import {ArtifactNotFoundError} from '../shared/errors'

export async function getArtifact(
  name: string,
  options?: {failIfNotFound?: boolean}
): Promise<GetArtifactResponse> {
  const s3Config = getS3Config()
  const artifactManager = new S3ArtifactManager(s3Config)

  try {
    const artifact = await artifactManager.getArtifact(name)
    return {
      artifact: {
        name: artifact.name,
        id: artifact.id,
        size: artifact.size || 0,
        createdAt: artifact.createdAt || new Date()
      }
    }
  } catch (error) {
    core.debug(`Failed to get artifact ${name}: ${error}`)

    // If failIfNotFound is true, rethrow the error
    if (options?.failIfNotFound) {
      throw error
    }

    // Otherwise wrap in ArtifactNotFoundError if it's not already one
    if (!(error instanceof ArtifactNotFoundError)) {
      throw new ArtifactNotFoundError(
        `Artifact not found for name: ${name}
        Please ensure that your artifact exists in S3 storage.`
      )
    }
    throw error
  }
}
