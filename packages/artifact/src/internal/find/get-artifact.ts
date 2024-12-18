import * as core from '@actions/core'
import { S3ArtifactManager } from '../s3/artifact-manager'
import { getArtifactManager } from '../shared/util'
import { GetArtifactResponse } from '../shared/interfaces'
import { ArtifactNotFoundError, InvalidResponseError } from '../shared/errors'
import { retry } from '../shared/retry'

export async function getArtifact(
  name: string,
  options?: { failIfNotFound?: boolean }
): Promise<GetArtifactResponse> {
  const artifactManager = getArtifactManager()

  try {
    const artifact = await retry(
      () => artifactManager.getArtifact(name),
      {
        retryableErrors: ['Temporary failure', 'timeout']
      }
    )

    if (!artifact || !artifact.name || !artifact.id) {
      throw new InvalidResponseError('Invalid or missing artifact data')
    }

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

    if (error instanceof InvalidResponseError) {
      throw new ArtifactNotFoundError(`Artifact not found or invalid: ${name}`)
    }

    if (error instanceof ArtifactNotFoundError && !options?.failIfNotFound) {
      return {
        artifact: {
          name,
          id: 0,
          size: 0,
          createdAt: new Date()
        }
      }
    }

    // Wrap any other errors in ArtifactNotFoundError
    if (!(error instanceof ArtifactNotFoundError)) {
      throw new ArtifactNotFoundError(`Failed to get artifact ${name}: ${error}`)
    }

    throw error
  }
}
