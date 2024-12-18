import fs from 'fs/promises'
import unzip from 'unzip-stream'
import {
  DownloadArtifactOptions,
  DownloadArtifactResponse
} from '../shared/interfaces'
import {getUserAgentString} from '../shared/user-agent'
import {getArtifactManager} from '../shared/util'
import {HttpClient} from '@actions/http-client'
import {ArtifactNotFoundError, NetworkError} from '../shared/errors'

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

export async function streamExtract(
  url: string,
  directory: string
): Promise<void> {
  try {
    await streamExtractExternal(url, directory)
  } catch (error) {
    if (error instanceof NetworkError) {
      throw error
    }
    throw new Error(`Failed to download artifact: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function streamExtractExternal(
  url: string,
  directory: string
): Promise<void> {
  const client = new HttpClient(getUserAgentString())

  try {
    const response = await client.get(url)
    if (response.message.statusCode !== 200) {
      throw new NetworkError(
        'NetworkingError',
        `Unexpected HTTP response from storage: ${response.message.statusCode} ${response.message.statusMessage}`
      )
    }

    const timeout = 30 * 1000 // 30 seconds

    return new Promise((resolve, reject) => {
      const timerFn = (): void => {
        const timeoutError = new NetworkError(
          'NetworkingError',
          `Storage chunk did not respond in ${timeout}ms`
        )
        response.message.destroy(timeoutError)
      }
      const timer = setTimeout(timerFn, timeout)

      response.message
        .on('data', () => {
          timer.refresh()
        })
        .on('error', (error: Error) => {
          clearTimeout(timer)
          reject(new NetworkError('NetworkingError', error.message))
        })
        .pipe(unzip.Extract({path: directory}))
        .on('close', () => {
          clearTimeout(timer)
          resolve()
        })
        .on('error', (error: Error) => {
          clearTimeout(timer)
          reject(error)
        })
    })
  } catch (error) {
    if (error instanceof NetworkError) {
      throw error
    }
    throw new NetworkError(
      'NetworkingError',
      error instanceof Error ? error.message : 'Unknown network error occurred'
    )
  }
}

export async function downloadArtifact(
  artifactId: number,
  options: DownloadArtifactOptions = {}
): Promise<DownloadArtifactResponse> {
  const artifactManager = getArtifactManager()
  const maxRetries = 5
  const retryDelayMs = 1000
  const downloadTimeout = 5 * 60 * 1000 // 5 minutes

  try {
    const artifact = await artifactManager.getArtifact(artifactId.toString())
    if (!artifact) {
      throw new Error('No artifacts found for ID')
    }

    const downloadPath = await resolveOrCreateDirectory(options.path)
    const timeoutPromise = new Promise<DownloadArtifactResponse>((_, reject) => {
      setTimeout(() => reject(new Error('Download timeout exceeded')), downloadTimeout)
    })

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const downloadPromise = (async (): Promise<DownloadArtifactResponse> => {
          const downloadUrl = await artifactManager.getSignedDownloadUrl(artifactId.toString())
          await streamExtract(downloadUrl, downloadPath)
          return {
            downloadPath,
            artifact
          }
        })()

        return await Promise.race([downloadPromise, timeoutPromise])
      } catch (error) {
        if (error instanceof NetworkError || (error instanceof Error && error.message === 'Download timeout exceeded')) {
          if (attempt === maxRetries) {
            throw new NetworkError('NetworkingError', `Failed to download after ${maxRetries} attempts: ${error.message}`)
          }
          await new Promise(resolve => setTimeout(resolve, retryDelayMs * Math.pow(2, attempt - 1)))
          continue
        }
        throw error
      }
    }

    throw new Error('Unexpected error during download')
  } catch (error) {
    if (error instanceof NetworkError) {
      throw error
    }
    if (error instanceof Error && error.message === 'Artifact not found') {
      throw new Error('No artifacts found for ID')
    }
    throw new Error(`Unable to download and extract artifact: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function resolveOrCreateDirectory(
  downloadPath?: string
): Promise<string> {
  if (!downloadPath) {
    downloadPath = process.env.WORKSPACE_PATH || process.cwd()
  }

  if (!(await exists(downloadPath))) {
    await fs.mkdir(downloadPath, {recursive: true})
  }

  return downloadPath
}
