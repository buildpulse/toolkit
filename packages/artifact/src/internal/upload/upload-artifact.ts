import * as core from '@actions/core'
import {
  UploadArtifactOptions,
  UploadArtifactResponse
} from '../shared/interfaces'
import {getRetentionDays} from './retention'
import {validateArtifactName} from './path-and-artifact-name-validation'
import {S3ArtifactManager} from '../s3/artifact-manager'
import {
  UploadZipSpecification,
  getUploadZipSpecification,
  validateRootDirectory
} from './upload-zip-specification'
import {getS3Config} from '../shared/config'
import {createZipUploadStream} from './zip'
import {FilesNotFoundError} from '../shared/errors'

export async function uploadArtifact(
  name: string,
  files: string[],
  rootDirectory: string,
  options?: UploadArtifactOptions | undefined
): Promise<UploadArtifactResponse> {
  validateArtifactName(name)
  validateRootDirectory(rootDirectory)

  const zipSpecification: UploadZipSpecification[] = getUploadZipSpecification(
    files,
    rootDirectory
  )
  if (zipSpecification.length === 0) {
    throw new FilesNotFoundError(
      zipSpecification.flatMap(s => (s.sourcePath ? [s.sourcePath] : []))
    )
  }

  // Create S3 artifact manager
  const s3Config = getS3Config()
  const artifactManager = new S3ArtifactManager(s3Config)

  // Get retention days from options or environment
  const retentionDays = options?.retentionDays || getRetentionDays()
  core.debug(`Retention days: ${retentionDays}`)

  // Create the artifact and get upload URL
  const {uploadUrl, artifactId} = await artifactManager.createArtifact(name)

  // Create zip stream for upload
  const zipUploadStream = await createZipUploadStream(
    zipSpecification,
    options?.compressionLevel
  )

  // Upload zip to S3
  const uploadResult = await artifactManager.uploadArtifact(
    `artifacts/${artifactId}/${name}`,
    zipUploadStream
  )

  // Finalize the artifact
  await artifactManager.finalizeArtifact(`artifacts/${artifactId}/${name}`)

  core.info(
    `Artifact ${name} successfully uploaded to S3. ID: ${artifactId}`
  )

  return {
    size: uploadResult.uploadSize,
    id: artifactId
  }
}
