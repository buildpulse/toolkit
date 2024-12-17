import os from 'os'

interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}


// Used for controlling the highWaterMark value of the zip that is being streamed
// The same value is used as the chunk size that is use during upload to blob storage
export function getUploadChunkSize(): number {
  return 8 * 1024 * 1024 // 8 MB Chunks
}

export function getRuntimeToken(): string {
  const token = process.env['ACTIONS_RUNTIME_TOKEN']
  if (!token) {
    throw new Error('Unable to get the ACTIONS_RUNTIME_TOKEN env variable')
  }
  return token
}

export function getResultsServiceUrl(): string {
  const resultsUrl = process.env['ACTIONS_RESULTS_URL']
  if (!resultsUrl) {
    throw new Error('Unable to get the ACTIONS_RESULTS_URL env variable')
  }

  return new URL(resultsUrl).origin
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

/**
 * Gets AWS credentials from environment variables
 * @returns AWS credentials object containing access key ID and secret access key
 * @throws Error if required credentials are not set
 */
export function getAwsCredentials(): AwsCredentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const sessionToken = process.env.AWS_SESSION_TOKEN

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'Required AWS credentials not found. Ensure AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are set'
    )
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken
  }
}

/**
 * Gets AWS region from environment variable with fallback
 * @returns AWS region string
 */
export function getAwsRegion(): string {
  return process.env.AWS_REGION || 'us-east-1'
}

/**
 * Gets optional custom AWS endpoint URL
 * @returns AWS endpoint URL if set, undefined otherwise
 */
export function getAwsEndpoint(): string | undefined {
  return process.env.AWS_ENDPOINT_URL
}
