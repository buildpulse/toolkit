import fs from 'fs/promises'
import * as github from '@actions/github'
import * as core from '@actions/core'
import {S3Client, GetObjectCommand} from '@aws-sdk/client-s3'
import * as httpClient from '@actions/http-client'
import unzip from 'unzip-stream'
import {
  DownloadArtifactOptions,
  DownloadArtifactResponse
} from '../shared/interfaces'
import {Readable} from 'stream'
import {getUserAgentString} from '../shared/user-agent'
import {getGitHubWorkspaceDir} from '../shared/config'
import {internalArtifactTwirpClient} from '../shared/artifact-twirp-client'
import {
  GetSignedArtifactURLRequest,
  Int64Value,
  ListArtifactsRequest
} from '../../generated'
import {getBackendIdsFromToken} from '../shared/util'
import {ArtifactNotFoundError} from '../shared/errors'

const scrubQueryParameters = (url: string): string => {
  const parsed = new URL(url)
  parsed.search = ''
  return parsed.toString()
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    } else {
      throw error
    }
  }
}

function isS3Url(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.hostname.endsWith('.amazonaws.com')
  } catch {
    return false
  }
}

async function downloadFromS3(url: string): Promise<Readable> {
  const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      sessionToken: process.env.AWS_SESSION_TOKEN
    }
  })

  try {
    // Parse S3 URL to get bucket and key
    const s3Url = new URL(url)
    const bucket = s3Url.hostname.split('.')[0]
    const key = s3Url.pathname.substring(1)

    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key
      })
    )

    return response.Body as Readable
  } catch (error) {
    core.error(`S3 download failed: ${error.message}`)
    throw error
  }
}

async function streamExtract(url: string, directory: string): Promise<void> {
  let retryCount = 0
  while (retryCount < 5) {
    try {
      await streamExtractExternal(url, directory)
      return
    } catch (error) {
      retryCount++
      core.debug(
        `Failed to download artifact after ${retryCount} retries due to ${error.message}. Retrying in 5 seconds...`
      )
      // wait 5 seconds before retrying
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }

  throw new Error(`Artifact download failed after ${retryCount} retries.`)
}

export async function streamExtractExternal(
  url: string,
  directory: string
): Promise<void> {
  let downloadStream: Readable

  if (isS3Url(url)) {
    core.debug('Using S3 client for artifact download')
    downloadStream = await downloadFromS3(url)
  } else {
    core.debug('Using HTTP client for artifact download')
    const client = new httpClient.HttpClient(getUserAgentString())
    const response = await client.get(url)
    if (response.message.statusCode !== 200) {
      throw new Error(
        `Unexpected HTTP response from blob storage: ${response.message.statusCode} ${response.message.statusMessage}`
      )
    }
    downloadStream = response.message
  }

  core.debug('Starting artifact extraction')

  const timeout = 30 * 1000 // 30 seconds

  return new Promise((resolve, reject) => {
    const timerFn = (): void => {
      response.message.destroy(
        new Error(`Blob storage chunk did not respond in ${timeout}ms`)
      )
    }
    const timer = setTimeout(timerFn, timeout)

    downloadStream
      .on('data', () => {
        timer.refresh()
      })
      .on('error', (error: Error) => {
        core.debug(
          `response.message: Artifact download failed: ${error.message}`
        )
        clearTimeout(timer)
        reject(error)
      })
      .pipe(unzip.Extract({path: directory}))
      .on('close', () => {
        clearTimeout(timer)
        resolve()
      })
      .on('error', (error: Error) => {
        reject(error)
      })
  })
}

export async function downloadArtifactPublic(
  artifactId: number,
  repositoryOwner: string,
  repositoryName: string,
  token: string,
  options?: DownloadArtifactOptions
): Promise<DownloadArtifactResponse> {
  const downloadPath = await resolveOrCreateDirectory(options?.path)

  const api = github.getOctokit(token)

  core.info(
    `Downloading artifact '${artifactId}' from '${repositoryOwner}/${repositoryName}'`
  )

  const {headers, status} = await api.rest.actions.downloadArtifact({
    owner: repositoryOwner,
    repo: repositoryName,
    artifact_id: artifactId,
    archive_format: 'zip',
    request: {
      redirect: 'manual'
    }
  })

  if (status !== 302) {
    throw new Error(`Unable to download artifact. Unexpected status: ${status}`)
  }

  const {location} = headers
  if (!location) {
    throw new Error(`Unable to redirect to artifact download url`)
  }

  core.info(
    `Redirecting to blob download url: ${scrubQueryParameters(location)}`
  )

  try {
    core.info(`Starting download of artifact to: ${downloadPath}`)
    await streamExtract(location, downloadPath)
    core.info(`Artifact download completed successfully.`)
  } catch (error) {
    throw new Error(`Unable to download and extract artifact: ${error.message}`)
  }

  return {downloadPath}
}

export async function downloadArtifactInternal(
  artifactId: number,
  options?: DownloadArtifactOptions
): Promise<DownloadArtifactResponse> {
  const downloadPath = await resolveOrCreateDirectory(options?.path)

  const artifactClient = internalArtifactTwirpClient()

  const {workflowRunBackendId, workflowJobRunBackendId} =
    getBackendIdsFromToken()

  const listReq: ListArtifactsRequest = {
    workflowRunBackendId,
    workflowJobRunBackendId,
    idFilter: Int64Value.create({value: artifactId.toString()})
  }

  const {artifacts} = await artifactClient.ListArtifacts(listReq)

  if (artifacts.length === 0) {
    throw new ArtifactNotFoundError(
      `No artifacts found for ID: ${artifactId}\nAre you trying to download from a different run? Try specifying a github-token with \`actions:read\` scope.`
    )
  }

  if (artifacts.length > 1) {
    core.warning('Multiple artifacts found, defaulting to first.')
  }

  const signedReq: GetSignedArtifactURLRequest = {
    workflowRunBackendId: artifacts[0].workflowRunBackendId,
    workflowJobRunBackendId: artifacts[0].workflowJobRunBackendId,
    name: artifacts[0].name
  }

  const {signedUrl} = await artifactClient.GetSignedArtifactURL(signedReq)

  core.info(
    `Redirecting to blob download url: ${scrubQueryParameters(signedUrl)}`
  )

  try {
    core.info(`Starting download of artifact to: ${downloadPath}`)
    await streamExtract(signedUrl, downloadPath)
    core.info(`Artifact download completed successfully.`)
  } catch (error) {
    throw new Error(`Unable to download and extract artifact: ${error.message}`)
  }

  return {downloadPath}
}

async function resolveOrCreateDirectory(
  downloadPath = getGitHubWorkspaceDir()
): Promise<string> {
  if (!(await exists(downloadPath))) {
    core.debug(
      `Artifact destination folder does not exist, creating: ${downloadPath}`
    )
    await fs.mkdir(downloadPath, {recursive: true})
  } else {
    core.debug(`Artifact destination folder already exists: ${downloadPath}`)
  }

  return downloadPath
}
