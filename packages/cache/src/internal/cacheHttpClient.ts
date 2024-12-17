import * as core from '@actions/core'
import {HttpClient} from '@actions/http-client'
import {BearerCredentialHandler} from '@actions/http-client/lib/auth'
import {
  RequestOptions,
  TypedResponse
} from '@actions/http-client/lib/interfaces'
import * as fs from 'fs'
import * as utils from './cacheUtils'
import {uploadCacheArchive} from './uploadUtils'
import {
  ArtifactCacheEntry,
  InternalCacheOptions,
  CommitCacheRequest,
  ReserveCacheRequest,
  ReserveCacheResponse,
  ITypedResponseWithError,
  ArtifactCacheList
} from './contracts'
import {downloadCacheHttpClient, downloadCacheFromS3} from './downloadUtils'
import {
  DownloadOptions,
  UploadOptions,
  getDownloadOptions,
  getUploadOptions
} from '../options'
import {
  isSuccessStatusCode,
  retryHttpClientResponse,
  retryTypedResponse
} from './requestUtils'
import {getCacheServiceURL} from './config'
import {getUserAgentString} from './shared/user-agent'

function getCacheApiUrl(resource: string): string {
  const baseUrl: string = getCacheServiceURL()
  if (!baseUrl) {
    throw new Error('Cache Service Url not found, unable to restore cache.')
  }

  const url = `${baseUrl}_apis/artifactcache/${resource}`
  core.debug(`Resource Url: ${url}`)
  return url
}

function createAcceptHeader(type: string, apiVersion: string): string {
  return `${type};api-version=${apiVersion}`
}

function getRequestOptions(): RequestOptions {
  const requestOptions: RequestOptions = {
    headers: {
      Accept: createAcceptHeader('application/json', '6.0-preview.1')
    }
  }

  return requestOptions
}

function createHttpClient(): HttpClient {
  const token = process.env['ACTIONS_RUNTIME_TOKEN'] || ''
  const bearerCredentialHandler = new BearerCredentialHandler(token)

  return new HttpClient(
    getUserAgentString(),
    [bearerCredentialHandler],
    getRequestOptions()
  )
}

export async function getCacheEntry(
  keys: string[],
  paths: string[],
  options?: InternalCacheOptions
): Promise<ArtifactCacheEntry | null> {
  const httpClient = createHttpClient()
  const version = utils.getCacheVersion(
    paths,
    options?.compressionMethod,
    options?.enableCrossOsArchive
  )

  const resource = `cache?keys=${encodeURIComponent(
    keys.join(',')
  )}&version=${version}`

  const response = await retryTypedResponse('getCacheEntry', async () =>
    httpClient.getJson<ArtifactCacheEntry>(getCacheApiUrl(resource))
  )
  // Cache not found
  if (response.statusCode === 204) {
    // List cache for primary key only if cache miss occurs
    if (core.isDebug()) {
      await printCachesListForDiagnostics(keys[0], httpClient, version)
    }
    return null
  }
  if (!isSuccessStatusCode(response.statusCode)) {
    throw new Error(`Cache service responded with ${response.statusCode}`)
  }

  const cacheResult = response.result
  const cacheDownloadUrl = cacheResult?.archiveLocation
  if (!cacheDownloadUrl) {
    // Cache achiveLocation not found. This should never happen, and hence bail out.
    throw new Error('Cache not found.')
  }
  core.setSecret(cacheDownloadUrl)
  core.debug(`Cache Result:`)
  core.debug(JSON.stringify(cacheResult))

  return cacheResult
}

async function printCachesListForDiagnostics(
  key: string,
  httpClient: HttpClient,
  version: string
): Promise<void> {
  const resource = `caches?key=${encodeURIComponent(key)}`
  const response = await retryTypedResponse('listCache', async () =>
    httpClient.getJson<ArtifactCacheList>(getCacheApiUrl(resource))
  )
  if (response.statusCode === 200) {
    const cacheListResult = response.result
    const totalCount = cacheListResult?.totalCount
    if (totalCount && totalCount > 0) {
      core.debug(
        `No matching cache found for cache key '${key}', version '${version} and scope ${process.env['GITHUB_REF']}. There exist one or more cache(s) with similar key but they have different version or scope. See more info on cache matching here: https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#matching-a-cache-key \nOther caches with similar key:`
      )
      for (const cacheEntry of cacheListResult?.artifactCaches || []) {
        core.debug(
          `Cache Key: ${cacheEntry?.cacheKey}, Cache Version: ${cacheEntry?.cacheVersion}, Cache Scope: ${cacheEntry?.scope}, Cache Created: ${cacheEntry?.creationTime}`
        )
      }
    }
  }
}

function parseS3Url(url: string): {bucket: string; key: string} | null {
  const s3Prefix = 's3://'
  if (!url.startsWith(s3Prefix)) {
    return null
  }

  const path = url.substring(s3Prefix.length)
  const firstSlash = path.indexOf('/')
  if (firstSlash === -1) {
    return null
  }

  return {
    bucket: path.substring(0, firstSlash),
    key: path.substring(firstSlash + 1)
  }
}

export async function downloadCache(
  archiveLocation: string,
  archivePath: string,
  options?: DownloadOptions
): Promise<void> {
  const downloadOptions = getDownloadOptions(options)

  try {
    const s3Location = parseS3Url(archiveLocation)
    if (s3Location && downloadOptions.useS3Client) {
      await downloadCacheFromS3(
        s3Location.bucket,
        s3Location.key,
        archivePath,
        downloadOptions
      )
      return
    }

    // Fall back to HTTP client for non-S3 URLs or when S3 is disabled
    await downloadCacheHttpClient(archiveLocation, archivePath)
  } catch (error) {
    const errorMessage = `Failed to download cache: ${error.message}`
    core.warning(errorMessage)
    throw error
  }
}

// Reserve Cache
export async function reserveCache(
  key: string,
  paths: string[],
  options?: InternalCacheOptions
): Promise<ITypedResponseWithError<ReserveCacheResponse>> {
  const httpClient = createHttpClient()
  const version = utils.getCacheVersion(
    paths,
    options?.compressionMethod,
    options?.enableCrossOsArchive
  )

  const reserveCacheRequest: ReserveCacheRequest = {
    key,
    version,
    cacheSize: options?.cacheSize
  }

  // Let postJson handle setting the headers for us
  const response = await retryTypedResponse(
    'reserveCache',
    async () =>
      await httpClient.postJson<ReserveCacheResponse>(
        getCacheApiUrl('caches'),
        reserveCacheRequest
      )
  )
  return response
}

function getContentRange(start: number, end: number): string {
  // Format: `bytes start-end/filesize
  // start and end are inclusive
  // filesize can be *
  // For a 200 byte chunk starting at byte 0:
  // Content-Range: bytes 0-199/*
  return `bytes ${start}-${end}/*`
}

async function uploadChunk(
  httpClient: HttpClient,
  resourceUrl: string,
  openStream: () => NodeJS.ReadableStream,
  start: number,
  end: number
): Promise<void> {
  core.debug(
    `Uploading chunk of size ${
      end - start + 1
    } bytes at offset ${start} with content range: ${getContentRange(
      start,
      end
    )}`
  )
  const additionalHeaders = {
    'Content-Type': 'application/octet-stream',
    'Content-Range': getContentRange(start, end)
  }

  const uploadChunkResponse = await retryHttpClientResponse(
    `uploadChunk (start: ${start}, end: ${end})`,
    async () =>
      httpClient.sendStream(
        'PATCH',
        resourceUrl,
        openStream(),
        additionalHeaders
      )
  )

  if (!isSuccessStatusCode(uploadChunkResponse.message.statusCode)) {
    throw new Error(
      `Cache service responded with ${uploadChunkResponse.message.statusCode} during upload chunk.`
    )
  }
}

async function uploadFile(
  httpClient: HttpClient,
  cacheId: number,
  archivePath: string,
  options?: UploadOptions
): Promise<void> {
  // Upload Chunks
  const fileSize = utils.getArchiveFileSizeInBytes(archivePath)
  const resourceUrl = getCacheApiUrl(`caches/${cacheId.toString()}`)
  const fd = fs.openSync(archivePath, 'r')
  const uploadOptions = getUploadOptions(options)

  const concurrency = utils.assertDefined(
    'uploadConcurrency',
    uploadOptions.uploadConcurrency
  )
  const maxChunkSize = utils.assertDefined(
    'uploadChunkSize',
    uploadOptions.uploadChunkSize
  )

  const parallelUploads = [...new Array(concurrency).keys()]
  core.debug('Awaiting all uploads')
  let offset = 0

  try {
    await Promise.all(
      parallelUploads.map(async () => {
        while (offset < fileSize) {
          const chunkSize = Math.min(fileSize - offset, maxChunkSize)
          const start = offset
          const end = offset + chunkSize - 1
          offset += maxChunkSize

          await uploadChunk(
            httpClient,
            resourceUrl,
            () =>
              fs
                .createReadStream(archivePath, {
                  fd,
                  start,
                  end,
                  autoClose: false
                })
                .on('error', error => {
                  throw new Error(
                    `Cache upload failed because file read failed with ${error.message}`
                  )
                }),
            start,
            end
          )
        }
      })
    )
  } finally {
    fs.closeSync(fd)
  }
  return
}

async function commitCache(
  httpClient: HttpClient,
  cacheId: number,
  filesize: number
): Promise<TypedResponse<null>> {
  const commitCacheRequest: CommitCacheRequest = {size: filesize}
  return await retryTypedResponse('commitCache', async () =>
    httpClient.postJson<null>(
      getCacheApiUrl(`caches/${cacheId.toString()}`),
      commitCacheRequest
    )
  )
}

export async function saveCache(
  cacheId: number,
  archivePath: string,
  options?: UploadOptions
): Promise<void> {
  const uploadOptions = getUploadOptions(options)
  const bucketName = process.env['AWS_BUCKET_NAME']
  const cacheSize = utils.getArchiveFileSizeInBytes(archivePath)

  core.info(
    `Cache Size: ~${Math.round(cacheSize / (1024 * 1024))} MB (${cacheSize} B)`
  )

  if (bucketName) {
    // Upload directly to S3
    const key = `cache/${cacheId}`
    core.debug('Uploading cache to S3')
    await uploadCacheArchive(bucketName, key, archivePath, uploadOptions)
    core.info('Cache saved successfully to S3')
  } else {
    // Upload using standard HTTP client
    const httpClient = createHttpClient()
    core.debug('Uploading cache')
    await uploadFile(httpClient, cacheId, archivePath, uploadOptions)

    // Commit the cache after uploading
    core.debug('Committing cache')
    const commitCacheResponse = await commitCache(
      httpClient,
      cacheId,
      cacheSize
    )
    if (!isSuccessStatusCode(commitCacheResponse.statusCode)) {
      throw new Error(
        `Cache service responded with ${commitCacheResponse.statusCode} during commit cache.`
      )
    }
    core.info('Cache saved successfully')
  }
}
