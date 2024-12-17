import {S3Client} from '@aws-sdk/client-s3'
import {Upload} from '@aws-sdk/lib-storage'
import * as core from '@actions/core'
import * as crypto from 'crypto'
import {Readable} from 'stream'
import {getUploadChunkTimeout} from '../shared/config'

export interface S3UploadResponse {
  uploadSize?: number
  sha256Hash?: string
}

interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

function getS3Client(): S3Client {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const sessionToken = process.env.AWS_SESSION_TOKEN

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials not found. Ensure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set.'
    )
  }

  return new S3Client({
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken
    },
    region: process.env.AWS_REGION || 'us-east-1'
  })
}

function parseS3Url(url: string): {bucket: string; key: string} {
  try {
    const s3Url = new URL(url)
    if (!s3Url.hostname.endsWith('.amazonaws.com')) {
      throw new Error('Invalid S3 URL')
    }

    const bucket = s3Url.hostname.split('.')[0]
    const key = s3Url.pathname.substring(1) // Remove leading slash

    return {bucket, key}
  } catch (error) {
    throw new Error(`Invalid S3 URL: ${error.message}`)
  }
}

export async function uploadZipToS3Storage(
  signedUploadUrl: string,
  zipStream: Readable
): Promise<S3UploadResponse> {
  const s3Client = getS3Client()
  const {bucket, key} = parseS3Url(signedUploadUrl)

  let uploadSize = 0
  let lastProgressTime = Date.now()
  const hashStream = crypto.createHash('sha256')
  const abortController = new AbortController()

  // Set up progress monitoring
  const progressCallback = (loaded: number): void => {
    uploadSize = loaded
    lastProgressTime = Date.now()
    core.info(`Uploaded ${loaded} bytes to S3`)
  }

  // Monitor for upload stalls
  const timeoutPromise = new Promise((_, reject) => {
    const checkProgress = setInterval(() => {
      if (Date.now() - lastProgressTime > getUploadChunkTimeout()) {
        clearInterval(checkProgress)
        abortController.abort()
        reject(new Error('Upload progress stalled.'))
      }
    }, 1000)

    // Clean up interval when upload completes
    abortController.signal.addEventListener('abort', () => {
      clearInterval(checkProgress)
    })
  })

  try {
    // Create a pass-through stream that computes hash while uploading
    zipStream.pipe(hashStream)

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: zipStream
      },
      queueSize: 4, // Number of concurrent upload parts
      partSize: 8 * 1024 * 1024, // 8MB chunk size
      abortSignal: abortController.signal
    })

    upload.on('httpUploadProgress', progress => {
      progressCallback(progress.loaded || 0)
    })

    // Wait for either upload completion or timeout
    await Promise.race([upload.done(), timeoutPromise])

    // Get the final hash
    hashStream.end()
    const sha256Hash = hashStream.read() as string

    return {
      uploadSize,
      sha256Hash
    }
  } catch (error) {
    core.error(`Failed to upload to S3: ${error.message}`)
    abortController.abort()
    throw error
  } finally {
    abortController.abort() // Ensure cleanup
  }
}
