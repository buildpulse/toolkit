import {S3Client, S3ClientConfig} from '@aws-sdk/client-s3'
import {Upload, Progress} from '@aws-sdk/lib-storage'
import * as core from '@actions/core'
import {createReadStream} from 'fs'

export function getS3Client(): S3Client {
  const region = process.env.AWS_REGION
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY

  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials not found. Please ensure AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY are set.'
    )
  }

  const config: S3ClientConfig = {
    region,
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  }

  return new S3Client(config)
}

export async function uploadToS3(
  bucket: string,
  key: string,
  filePath: string,
  options?: {
    partSize?: number
    queueSize?: number
  }
): Promise<void> {
  const client = getS3Client()
  const upload = new Upload({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStream(filePath)
    },
    queueSize: options?.queueSize || 4,
    partSize: options?.partSize || 32 * 1024 * 1024
  })

  upload.on('httpUploadProgress', (progress: Progress) => {
    core.debug(`Uploaded ${progress.loaded} of ${progress.total} bytes`)
  })

  await upload.done()
}
