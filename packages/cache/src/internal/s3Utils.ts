import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface S3UploadProgress {
  loadedBytes: number
}

export interface S3DownloadProgress {
  loadedBytes: number
}

export class S3Utils {
  private client: S3Client
  private bucket: string

  constructor() {
    this.client = new S3Client({
      region: process.env.AWS_REGION
    })
    this.bucket = process.env.CACHE_S3_BUCKET || ''
    if (!this.bucket) {
      throw new Error('CACHE_S3_BUCKET environment variable is required')
    }
  }

  getClient(): S3Client {
    return this.client
  }

  async downloadRange(bucket: string, key: string, start: number, end: number): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${start}-${end}`
    })

    const response = await this.client.send(command)
    if (!response.Body) {
      throw new Error('Empty response body from S3')
    }

    return Buffer.from(await response.Body.transformToByteArray())
  }

  async getObjectSize(bucket: string, key: string): Promise<number> {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    })

    const response = await this.client.send(command)
    if (!response.ContentLength) {
      throw new Error('Unable to determine content length')
    }

    return response.ContentLength
  }

  async generateUploadUrl(key: string, version: string): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${key}/${version}`
    })
    return getSignedUrl(this.client, command, { expiresIn: 3600 })
  }

  async generateDownloadUrl(key: string, version: string): Promise<string | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: `${key}/${version}`
      })
      return getSignedUrl(this.client, command, { expiresIn: 3600 })
    } catch (error) {
      return null
    }
  }
}
