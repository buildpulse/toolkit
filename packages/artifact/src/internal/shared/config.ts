import os from 'os'
import {S3ClientConfig} from '@aws-sdk/client-s3'

// Used for controlling the highWaterMark value of the zip that is being streamed
// The same value is used as the chunk size that is use during upload to blob storage
export function getUploadChunkSize(): number {
  return 8 * 1024 * 1024 // 8 MB Chunks
}

export function getS3Config(): S3ClientConfig {
  const region = process.env['AWS_REGION'] || 'us-east-1'
  const endpoint = process.env['AWS_ENDPOINT_URL']
  const bucket = process.env['AWS_ARTIFACT_BUCKET']

  if (!bucket) {
    throw new Error('AWS_ARTIFACT_BUCKET environment variable is not set')
  }

  const config: S3ClientConfig = {
    region,
    ...(endpoint && {endpoint})
  }

  // If credentials are provided via environment variables, use them
  const accessKeyId = process.env['AWS_ACCESS_KEY_ID']
  const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY']
  if (accessKeyId && secretAccessKey) {
    config.credentials = {
      accessKeyId,
      secretAccessKey
    }
  }

  return config
}

export function isGhes(): boolean {
  const ghUrl = new URL(
    process.env['GITHUB_SERVER_URL'] || 'https://github.com'
  )

  const hostname = ghUrl.hostname.trimEnd().toUpperCase()
  const isGitHubHost = hostname === 'GITHUB.COM'
  const isGheHost = hostname.endsWith('.GHE.COM')
  const isLocalHost = hostname.endsWith('.LOCALHOST')

  return !isGitHubHost && !isGheHost && !isLocalHost
}

export function getGitHubWorkspaceDir(): string {
  const ghWorkspaceDir = process.env['GITHUB_WORKSPACE']
  if (!ghWorkspaceDir) {
    throw new Error('Unable to get the GITHUB_WORKSPACE env variable')
  }
  return ghWorkspaceDir
}

// Mimics behavior of azcopy: https://learn.microsoft.com/en-us/azure/storage/common/storage-use-azcopy-optimize
// If your machine has fewer than 5 CPUs, then the value of this variable is set to 32.
// Otherwise, the default value is equal to 16 multiplied by the number of CPUs. The maximum value of this variable is 300.
export function getConcurrency(): number {
  const numCPUs = os.cpus().length

  if (numCPUs <= 4) {
    return 32
  }

  const concurrency = 16 * numCPUs
  return concurrency > 300 ? 300 : concurrency
}

export function getUploadChunkTimeout(): number {
  return 300_000 // 5 minutes
}
