import { S3Client } from '@aws-sdk/client-s3'

export interface S3UploadProgress {
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
}
