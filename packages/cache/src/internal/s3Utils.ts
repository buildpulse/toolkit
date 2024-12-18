import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

export interface S3UploadProgress {
  loadedBytes: number
}

export interface S3DownloadProgress {
  loadedBytes: number
}

export class S3Utils {
  private client: S3Client

  constructor() {
    this.client = new S3Client({
      region: process.env.AWS_REGION
    })
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
}
