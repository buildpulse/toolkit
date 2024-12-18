import * as core from '@actions/core'

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

export function getCacheServiceVersion(): string {
  // Cache service v2 is not supported on GHES. We will default to
  // cache service v1 even if the feature flag was enabled by user.
  if (isGhes()) return 'v1'

  return process.env['ACTIONS_CACHE_SERVICE_V2'] ? 'v2' : 'v1'
}

export function getCacheServiceURL(): string {
  const version = getCacheServiceVersion()

  // Based on the version of the cache service, we will determine which
  // URL to use.
  switch (version) {
    case 'v1':
      return (
        process.env['ACTIONS_CACHE_URL'] ||
        process.env['ACTIONS_RESULTS_URL'] ||
        ''
      )
    case 'v2':
      return process.env['ACTIONS_RESULTS_URL'] || ''
    default:
      throw new Error(`Unsupported cache service version: ${version}`)
  }
}

export function getS3Config(): {
  bucket: string
  region: string
  endpoint?: string
} {
  const bucket = process.env['CACHE_S3_BUCKET']
  if (!bucket) {
    throw new Error(
      'CACHE_S3_BUCKET environment variable is required for S3 cache storage'
    )
  }

  const region = process.env['AWS_REGION'] || 'us-east-1'
  const endpoint = process.env['AWS_ENDPOINT']

  core.debug(`Using S3 bucket: ${bucket}`)
  core.debug(`Using AWS region: ${region}`)
  if (endpoint) {
    core.debug(`Using custom S3 endpoint: ${endpoint}`)
  }

  return {
    bucket,
    region,
    endpoint
  }
}
