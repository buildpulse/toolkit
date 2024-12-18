import * as core from '@actions/core'
import {IS3ArtifactManager} from '../s3/types'
import {getS3Config} from './config'

let artifactManager: IS3ArtifactManager | undefined

export function getArtifactManager(): IS3ArtifactManager {
  if (!artifactManager) {
    try {
      const config = getS3Config()
      if (!config) {
        throw new Error('S3 configuration is required')
      }
      if (!config.bucket) {
        throw new Error('S3 bucket is required')
      }
      const {S3ArtifactManager} = require('../s3/artifact-manager')
      artifactManager = new S3ArtifactManager(config)
    } catch (error) {
      if (error instanceof Error && error.message === 'S3 configuration is required') {
        throw error
      }
      if (error instanceof Error && error.message === 'S3 bucket is required') {
        throw error
      }
      throw new Error(`S3 configuration is required: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return artifactManager!
}
