import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  S3ClientConfig
} from '@aws-sdk/client-s3'
import {Upload} from '@aws-sdk/lib-storage'
import * as core from '@actions/core'
import {Readable} from 'stream'
import * as fs from 'fs'

// Default chunk size for multipart uploads (8MB)
const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024

interface S3ProgressCallback {
  (bytesTransferred: number): void
}

interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export function getS3Client(): S3Client {
  const credentials = getS3Credentials()
  const config: S3ClientConfig = {
    credentials,
    region: process.env.AWS_REGION || 'us-east-1',
    maxAttempts: 3
  }

  return new S3Client(config)
}

function getS3Credentials(): S3Credentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const sessionToken = process.env.AWS_SESSION_TOKEN

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'AWS credentials not found. Ensure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set.'
    )
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken
  }
}

export function parseS3Url(url: string): {
  Bucket: string
  Key: string
} {
  const s3Url = new URL(url)
  if (!s3Url.hostname.endsWith('.amazonaws.com')) {
    throw new Error('Invalid S3 URL')
  }

  const bucket = s3Url.hostname.split('.')[0]
  const key = s3Url.pathname.substring(1) // Remove leading slash

  return {
    Bucket: bucket,
    Key: key
  }
}

export async function uploadToS3(
  s3Client: S3Client,
  sourceFile: string,
  destinationUrl: string,
  onProgress?: S3ProgressCallback
): Promise<void> {
  const {Bucket, Key} = parseS3Url(destinationUrl)
  const fileStream = fs.createReadStream(sourceFile)
  const fileSize = (await fs.promises.stat(sourceFile)).size

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket,
      Key,
      Body: fileStream
    },
    queueSize: 4,
    partSize: DEFAULT_CHUNK_SIZE
  })

  upload.on('httpUploadProgress', progress => {
    if (onProgress) {
      onProgress(progress.loaded || 0)
    }
  })

  try {
    await upload.done()
    core.debug(`Successfully uploaded ${fileSize} bytes to ${destinationUrl}`)
  } catch (error) {
    core.error(`Failed to upload to S3: ${error.message}`)
    throw error
  }
}

export async function downloadFromS3(
  s3Client: S3Client,
  sourceUrl: string,
  destinationPath: string,
  onProgress?: S3ProgressCallback
): Promise<void> {
  const {Bucket, Key} = parseS3Url(sourceUrl)
  const fileStream = fs.createWriteStream(destinationPath)

  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket,
        Key
      })
    )

    if (!response.Body) {
      throw new Error('Response body is undefined')
    }

    const stream = response.Body as unknown as Readable
    let downloadedBytes = 0
    stream.on('data', chunk => {
      downloadedBytes += chunk.length
      if (onProgress) {
        onProgress(downloadedBytes)
      }
    })

    await new Promise((resolve, reject) => {
      fileStream.on('error', error => {
        reject(error)
      })

      fileStream.on('finish', () => {
        resolve(undefined)
      })

      stream.pipe(fileStream)
    })

    core.debug(
      `Successfully downloaded ${downloadedBytes} bytes from ${sourceUrl}`
    )
  } catch (error) {
    core.error(`Failed to download from S3: ${error.message}`)
    throw error
  } finally {
    fileStream.end()
  }
}

export async function getSignedS3Url(
  s3Client: S3Client,
  url: string,
  operation: 'upload' | 'download',
  expiresInSeconds = 3600
): Promise<string> {
  const {Bucket, Key} = parseS3Url(url)
  const command =
    operation === 'upload'
      ? new PutObjectCommand({Bucket, Key})
      : new GetObjectCommand({Bucket, Key})

  try {
    const {getSignedUrl} = await import('@aws-sdk/s3-request-presigner')
    return await getSignedUrl(s3Client, command, {
      expiresIn: expiresInSeconds
    })
  } catch (error) {
    core.error(`Failed to generate signed URL: ${error.message}`)
    throw error
  }
}

export function isS3Url(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname.endsWith('.amazonaws.com')
  } catch {
    return false
  }
}
