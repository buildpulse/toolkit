import * as core from '@actions/core'
import { S3ArtifactManager } from '../s3/artifact-manager'
import { getS3Config } from './config'

/**
 * Gets the artifact manager instance
 */
export function getArtifactManager(): S3ArtifactManager {
  const s3Config = getS3Config()
  return new S3ArtifactManager(s3Config)
}
