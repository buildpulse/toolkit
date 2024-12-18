import * as core from '@actions/core'
import {
  UploadArtifactOptions,
  UploadArtifactResponse
} from '../shared/interfaces'
import {getExpiration} from './retention'
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

  // Create the artifact and get upload URL
  const {uploadUrl, key} = await artifactManager.createArtifact(name)

  // Create zip stream for upload
  const zipUploadStream = await createZipUploadStream(
    zipSpecification,
    options?.compressionLevel
  )

  // Upload zip to S3
  const uploadResult = await artifactManager.uploadArtifact(
    uploadUrl,
    zipUploadStream
  )

  // Finalize the artifact with metadata
  const metadata = {
    name,
    size: uploadResult.uploadSize || 0,
    hash: uploadResult.sha256Hash ? `sha256:${uploadResult.sha256Hash}` : undefined
  }

  const finalizedArtifact = await artifactManager.finalizeArtifact(key, metadata)

  core.info(
    `Artifact ${name}.zip successfully uploaded to S3. Key: ${finalizedArtifact.key}`
  )

  return {
    size: uploadResult.uploadSize,
    id: Date.now() // Use timestamp as ID since we no longer have GitHub artifact IDs
  }
}
