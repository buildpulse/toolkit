import fs from 'fs/promises'
import unzip from 'unzip-stream'
import {
  DownloadArtifactOptions,
  DownloadArtifactResponse
} from '../shared/interfaces'
import {getUserAgentString} from '../shared/user-agent'
import {S3ArtifactManager} from '../s3/artifact-manager'
import {HttpClient} from '@actions/http-client'
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

async function streamExtract(url: string, directory: string): Promise<void> {
  let retryCount = 0
  while (retryCount < 5) {
    try {
      await streamExtractExternal(url, directory)
      return
    } catch (error) {
      retryCount++
      console.debug(
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
  const client = new HttpClient(getUserAgentString())
  const response = await client.get(url)
  if (response.message.statusCode !== 200) {
    throw new Error(
      `Unexpected HTTP response from blob storage: ${response.message.statusCode} ${response.message.statusMessage}`
    )
  }

  const timeout = 30 * 1000 // 30 seconds

  return new Promise((resolve, reject) => {
    const timerFn = (): void => {
      response.message.destroy(
        new Error(`Blob storage chunk did not respond in ${timeout}ms`)
      )
    }
    const timer = setTimeout(timerFn, timeout)

    response.message
      .on('data', () => {
        timer.refresh()
      })
      .on('error', (error: Error) => {
        console.debug(
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

export async function downloadArtifact(
  artifactId: number,
  options?: DownloadArtifactOptions
): Promise<DownloadArtifactResponse> {
  const downloadPath = await resolveOrCreateDirectory(options?.path)
  const s3Manager = S3ArtifactManager.fromEnvironment()

  try {
    const signedUrl = await s3Manager.getSignedDownloadUrl(artifactId.toString())

    console.info(
      `Starting download of artifact to: ${downloadPath}`
    )
    await streamExtract(signedUrl, downloadPath)
    console.info(`Artifact download completed successfully.`)
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      throw new ArtifactNotFoundError(
        `No artifacts found for ID: ${artifactId}\nAre you trying to download from a different run?`
      )
    }
    throw new Error(`Unable to download and extract artifact: ${error.message}`)
  }

  return {downloadPath}
}

async function resolveOrCreateDirectory(
  downloadPath?: string
): Promise<string> {
  if (!downloadPath) {
    downloadPath = process.env.WORKSPACE_PATH || process.cwd()
  }

  if (!(await exists(downloadPath))) {
    console.debug(
      `Artifact destination folder does not exist, creating: ${downloadPath}`
    )
    await fs.mkdir(downloadPath, {recursive: true})
  } else {
    console.debug(`Artifact destination folder already exists: ${downloadPath}`)
  }

  return downloadPath
}
