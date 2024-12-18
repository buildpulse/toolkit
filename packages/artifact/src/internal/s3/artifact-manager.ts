import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  S3ClientConfig
} from '@aws-sdk/client-s3'
import {getSignedUrl} from '@aws-sdk/s3-request-presigner'
import * as core from '@actions/core'
import {v4 as uuidv4} from 'uuid'
import {S3UploadError} from '../shared/errors'
import {Readable} from 'stream'
import {Upload} from '@aws-sdk/lib-storage'

export interface ArtifactMetadata {
  name: string
  size: number
  hash?: string
  bucket: string
  key: string
  expiresAt?: Date
}

export type S3Config = S3ClientConfig & {
  bucket: string
}

export class S3ArtifactManager {
  private s3Client: S3Client
  private bucket: string

  constructor(config: S3Config) {
    const {bucket, ...s3Config} = config
    this.s3Client = new S3Client(s3Config)
    this.bucket = bucket
  }

  async createArtifact(name: string): Promise<{uploadUrl: string; key: string}> {
    try {
      const key = `artifacts/${uuidv4()}/${name}`
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key
      })

      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: 3600 // URL expires in 1 hour
      })

      core.debug(`Generated presigned URL for artifact upload: ${key}`)
      return {uploadUrl, key}
    } catch (error) {
      throw new S3UploadError(
        `Failed to create artifact upload URL: ${S3UploadError.getErrorMessage(error)}`,
        error?.code
      )
    }
  }

  async uploadArtifact(
    uploadUrl: string,
    stream: Readable
  ): Promise<{uploadSize?: number; sha256Hash?: string}> {
    try {
      const url = new URL(uploadUrl)
      const key = url.pathname.slice(1) // Remove leading slash

      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: stream
        }
      })

      await upload.done()

      // Get object info to return size
      const headResponse = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key
        })
      )

      return {
        uploadSize: headResponse.ContentLength,
        sha256Hash: headResponse.ETag?.replace(/"/g, '') // Remove quotes from ETag
      }
    } catch (error) {
      throw new S3UploadError(
        `Failed to upload artifact: ${S3UploadError.getErrorMessage(error)}`,
        error?.code
      )
    }
  }

  async finalizeArtifact(
    key: string,
    metadata: Omit<ArtifactMetadata, 'bucket' | 'key'>
  ): Promise<ArtifactMetadata> {
    try {
      // Verify the object exists
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key
        })
      )

      const finalMetadata: ArtifactMetadata = {
        ...metadata,
        bucket: this.bucket,
        key
      }

      // Store metadata as S3 object tags or in a separate metadata object
      const metadataKey = `${key}.metadata.json`
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: metadataKey,
          Body: JSON.stringify(finalMetadata),
          ContentType: 'application/json'
        })
      )

      core.debug(`Finalized artifact metadata: ${metadataKey}`)
      return finalMetadata
    } catch (error) {
      throw new S3UploadError(
        `Failed to finalize artifact: ${S3UploadError.getErrorMessage(error)}`,
        error?.code
      )
    }
  }

  async getArtifactMetadata(key: string): Promise<ArtifactMetadata> {
    try {
      const metadataKey = `${key}.metadata.json`
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: metadataKey
        })
      )

      const bodyContent = await response.Body?.transformToString()
      if (!bodyContent) {
        throw new Error('Failed to read artifact metadata: Empty response body')
      }
      const metadata = JSON.parse(bodyContent)
      return metadata as ArtifactMetadata
    } catch (error) {
      throw new Error(`Failed to get artifact metadata: ${error.message}`)
    }
  }

  async createMultipartUpload(
    name: string
  ): Promise<{uploadId: string; key: string}> {
    try {
      const key = `artifacts/${uuidv4()}/${name}`
      const response = await this.s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key
        })
      )

      if (!response.UploadId) {
        throw new S3UploadError('Failed to get upload ID')
      }

      return {
        uploadId: response.UploadId,
        key
      }
    } catch (error) {
      throw new S3UploadError(
        `Failed to create multipart upload: ${S3UploadError.getErrorMessage(error)}`,
        error?.code
      )
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ETag: string; PartNumber: number}>
  ): Promise<void> {
    try {
      await this.s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {Parts: parts}
        })
      )
    } catch (error) {
      throw new S3UploadError(
        `Failed to complete multipart upload: ${S3UploadError.getErrorMessage(error)}`,
        error?.code
      )
    }
  }

  async getSignedDownloadUrl(artifactId: string): Promise<string> {
    try {
      const metadata = await this.getArtifactMetadata(artifactId)
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: metadata.key
      })

      const downloadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: 3600 // URL expires in 1 hour
      })

      return downloadUrl
    } catch (error) {
      throw new Error(`Failed to get signed download URL: ${error.message}`)
    }
  }

  static fromEnvironment(): S3ArtifactManager {
    const region = process.env.AWS_REGION || 'us-east-1'
    const bucket = process.env.AWS_S3_BUCKET

    if (!bucket) {
      throw new Error('AWS_S3_BUCKET environment variable is required')
    }

    return new S3ArtifactManager({
      region,
      bucket,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
      }
    })
  }
}
