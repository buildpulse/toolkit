import * as core from '@actions/core'
import { S3ArtifactManager } from '../s3/artifact-manager'
import { getS3Config } from '../shared/config'
import { ListArtifactsResponse, Artifact } from '../shared/interfaces'
import { getArtifactManager } from '../shared/util'

/**
 * Lists all artifacts in S3 storage
 * @param latest if true, only return the latest version of each artifact
 */
export async function listArtifacts(
  latest = false
): Promise<ListArtifactsResponse> {
  const artifactManager = getArtifactManager()

  try {
    let artifacts = await artifactManager.listArtifacts()

    // Ensure artifacts is always an array
    artifacts = artifacts || []

    if (latest) {
      artifacts = filterLatest(artifacts)
    }

    core.info(`Found ${artifacts.length} artifact(s)`)
    return { artifacts }
  } catch (error) {
    core.debug(`Failed to list artifacts: ${error}`)
    throw error
  }
}

/**
 * Filters a list of artifacts to only include the latest artifact for each name
 * @param artifacts The artifacts to filter
 * @returns The filtered list of artifacts
 */
function filterLatest(artifacts: Artifact[]): Artifact[] {
  return artifacts
    .sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0
      return b.createdAt.getTime() - a.createdAt.getTime()
    })
    .filter((artifact, index, self) =>
      index === self.findIndex(a => a.name === artifact.name)
    )
}
