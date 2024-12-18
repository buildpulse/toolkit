import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  S3ClientConfig
} from '@aws-sdk/client-s3'
import {getSignedUrl} from '@aws-sdk/s3-request-presigner'
import * as core from '@actions/core'
import {v4 as uuidv4} from 'uuid'
import {Readable} from 'stream'
import {Upload} from '@aws-sdk/lib-storage'
import {Artifact, DeleteArtifactResponse} from '../shared/interfaces'
import {ArtifactNotFoundError, S3UploadError} from '../shared/errors'
import {retry} from '../shared/retry'

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

  async listArtifacts(): Promise<Artifact[]> {
    return retry(
      async () => {
        try {
          const response = await this.s3Client.send(
            new ListObjectsV2Command({
              Bucket: this.bucket,
              Prefix: 'artifacts/'
            })
          )

          const artifacts: Artifact[] = []
          for (const object of response.Contents || []) {
            if (!object.Key?.endsWith('.metadata.json')) {
              const name = object.Key?.split('/').pop() || ''
              artifacts.push({
                name,
                id: parseInt(object.Key?.split('/')[1] || '0', 10),
                size: object.Size || 0,
                createdAt: object.LastModified
              })
            }
          }

          return artifacts
        } catch (error) {
          throw new Error(`Failed to list artifacts: ${error}`)
        }
      },
      {
        retryableErrors: ['Temporary failure', 'timeout', 'NetworkingError']
      }
    )
  }

  async getArtifact(name: string): Promise<Artifact> {
    return retry(
      async () => {
        try {
          const response = await this.s3Client.send(
            new HeadObjectCommand({
              Bucket: this.bucket,
              Key: `artifacts/${name}`
            })
          )

          if (!response) {
            throw new ArtifactNotFoundError(`Artifact not found: ${name}`)
          }

          return {
            name,
            id: parseInt(response.Metadata?.['artifact-id'] || '0', 10),
            size: response.ContentLength || 0,
            createdAt: response.LastModified
          }
        } catch (error) {
          throw new ArtifactNotFoundError(`Failed to get artifact ${name}: ${error}`)
        }
      },
      {
        retryableErrors: ['Temporary failure', 'timeout', 'NetworkingError']
      }
    )
  }

  async deleteArtifact(artifactId: string): Promise<DeleteArtifactResponse> {
    return retry(
      async () => {
        try {
          await this.s3Client.send(
            new DeleteObjectCommand({
              Bucket: this.bucket,
              Key: `artifacts/${artifactId}`
            })
          )
          return {
            success: true,
            id: parseInt(artifactId, 10)
          }
        } catch (error) {
          throw new Error(`Failed to delete artifact: ${error}`)
        }
      },
      {
        retryableErrors: ['Temporary failure', 'timeout', 'NetworkingError']
      }
    )
  }

  async createArtifact(name: string): Promise<{uploadUrl: string; artifactId: number}> {
    return retry(
      async () => {
        try {
          const artifactId = Date.now()
          const key = `artifacts/${artifactId}/${name}`
          const command = new CreateMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key,
            Metadata: {
              'artifact-id': artifactId.toString()
            }
          })

          const {UploadId} = await this.s3Client.send(command)
          if (!UploadId) {
            throw new S3UploadError('Failed to create multipart upload', 'NoUploadId')
          }

          const uploadUrl = await getSignedUrl(this.s3Client, command, {
            expiresIn: 3600
          })

          return {uploadUrl, artifactId}
        } catch (error) {
          throw new S3UploadError(
            `Failed to create artifact upload: ${error}`,
            error?.code
          )
        }
      },
      {
        retryableErrors: ['Temporary failure', 'timeout', 'NetworkingError']
      }
    )
  }

  async uploadArtifact(
    key: string,
    stream: Readable
  ): Promise<{uploadSize?: number; sha256Hash?: string; uploadId?: string}> {
    return retry(
      async () => {
        try {
          const command = new CreateMultipartUploadCommand({
            Bucket: this.bucket,
            Key: key
          })
          const {UploadId} = await this.s3Client.send(command)

          const upload = new Upload({
            client: this.s3Client,
            params: {
              Bucket: this.bucket,
              Key: key,
              Body: stream
            }
          })

          await upload.done()

          const headResponse = await this.s3Client.send(
            new HeadObjectCommand({
              Bucket: this.bucket,
              Key: key
            })
          )

          return {
            uploadSize: headResponse.ContentLength,
            sha256Hash: headResponse.ETag?.replace(/"/g, ''),
            uploadId: UploadId
          }
        } catch (error) {
          throw new S3UploadError(
            `Failed to upload artifact: ${error}`,
            error?.code
          )
        }
      },
      {
        retryableErrors: ['Temporary failure', 'timeout', 'NetworkingError']
      }
    )
  }

  async finalizeArtifact(key: string, uploadId: string): Promise<void> {
    return retry(
      async () => {
        try {
          await this.s3Client.send(
            new CompleteMultipartUploadCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: uploadId
            })
          )
        } catch (error) {
          throw new S3UploadError(
            `Failed to finalize artifact: ${error}`,
            error?.code
          )
        }
      },
      {
        retryableErrors: ['Temporary failure', 'timeout', 'NetworkingError']
      }
    )
  }

  async getSignedDownloadUrl(key: string): Promise<string> {
    return retry(
      async () => {
        try {
          const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: key
          })

          const downloadUrl = await getSignedUrl(this.s3Client, command, {
            expiresIn: 3600
          })

          return downloadUrl
        } catch (error) {
          throw new Error(`Failed to generate signed URL: ${error}`)
        }
      },
      {
        retryableErrors: ['Temporary failure', 'timeout', 'NetworkingError']
      }
    )
  }

  static fromEnvironment(): S3ArtifactManager {
    const config: S3Config = {
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || ''
      },
      bucket: process.env.AWS_S3_BUCKET || ''
    }
    return new S3ArtifactManager(config)
  }
}
