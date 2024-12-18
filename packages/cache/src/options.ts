import * as core from '@actions/core'

/**
 * Options to control cache upload
 */
export interface UploadOptions {
  /**
   * Indicates whether to use the S3 SDK for improved reliability
   * and performance when uploading to S3
   *
   * @default false
   */
  useS3?: boolean
  /**
   * Number of parallel cache upload
   *
   * @default 4
   */
  uploadConcurrency?: number
  /**
   * Maximum chunk size in bytes for cache upload
   *
   * @default 32MB
   */
  uploadChunkSize?: number
  /**
   * Archive size in bytes
   */
  archiveSizeBytes?: number
  /**
   * Custom S3 endpoint URL (optional)
   * For use with S3-compatible storage services
   *
   * @default undefined
   */
  s3Endpoint?: string
}

/**
 * Options to control cache download
 */
export interface DownloadOptions {
  /**
   * Indicates whether to use the S3 SDK for improved reliability
   * and performance when downloading from S3
   *
   * @default false
   */
  useS3?: boolean

  /**
   * Number of parallel downloads when using S3
   *
   * @default 8
   */
  downloadConcurrency?: number

  /**
   * Indicates whether to use Actions HttpClient with concurrency
   * for downloads
   */
  concurrentBlobDownloads?: boolean

  /**
   * Maximum time for each download request, in milliseconds
   *
   * @default 30000
   */
  timeoutInMs?: number

  /**
   * Time after which a segment download should be aborted if stuck
   *
   * @default 600000
   */
  segmentTimeoutInMs?: number

  /**
   * Whether to skip downloading the cache entry.
   * If lookupOnly is set to true, the restore function will only check if
   * a matching cache entry exists and return the cache key if it does.
   *
   * @default false
   */
  lookupOnly?: boolean

  /**
   * Custom S3 endpoint URL (optional)
   * For use with S3-compatible storage services
   *
   * @default undefined
   */
  s3Endpoint?: string
}

/**
 * Returns a copy of the upload options with defaults filled in.
 *
 * @param copy the original upload options
 */
export function getUploadOptions(copy?: UploadOptions): UploadOptions {
  // Defaults if not overriden
  const result: UploadOptions = {
    useS3: false,
    uploadConcurrency: 4,
    uploadChunkSize: 32 * 1024 * 1024
  }

  if (copy) {
    if (typeof copy.useS3 === 'boolean') {
      result.useS3 = copy.useS3
    }

    if (typeof copy.uploadConcurrency === 'number') {
      result.uploadConcurrency = copy.uploadConcurrency
    }

    if (typeof copy.uploadChunkSize === 'number') {
      result.uploadChunkSize = copy.uploadChunkSize
    }

    if (typeof copy.s3Endpoint === 'string') {
      result.s3Endpoint = copy.s3Endpoint
    }
  }

  /**
   * Add env var overrides
   */
  // Cap the uploadConcurrency at 32
  result.uploadConcurrency = !isNaN(
    Number(process.env['CACHE_UPLOAD_CONCURRENCY'])
  )
    ? Math.min(32, Number(process.env['CACHE_UPLOAD_CONCURRENCY']))
    : result.uploadConcurrency
  // Cap the uploadChunkSize at 128MiB
  result.uploadChunkSize = !isNaN(
    Number(process.env['CACHE_UPLOAD_CHUNK_SIZE'])
  )
    ? Math.min(
        128 * 1024 * 1024,
        Number(process.env['CACHE_UPLOAD_CHUNK_SIZE']) * 1024 * 1024
      )
    : result.uploadChunkSize

  core.debug(`Use S3 SDK: ${result.useS3}`)
  core.debug(`Upload concurrency: ${result.uploadConcurrency}`)
  core.debug(`Upload chunk size: ${result.uploadChunkSize}`)
  if (result.s3Endpoint) {
    core.debug(`S3 endpoint: ${result.s3Endpoint}`)
  }

  return result
}

/**
 * Returns a copy of the download options with defaults filled in.
 *
 * @param copy the original download options
 */
export function getDownloadOptions(copy?: DownloadOptions): DownloadOptions {
  const result: DownloadOptions = {
    useS3: false,
    concurrentBlobDownloads: true,
    downloadConcurrency: 8,
    timeoutInMs: 30000,
    segmentTimeoutInMs: 600000,
    lookupOnly: false
  }

  if (copy) {
    if (typeof copy.useS3 === 'boolean') {
      result.useS3 = copy.useS3
    }

    if (typeof copy.concurrentBlobDownloads === 'boolean') {
      result.concurrentBlobDownloads = copy.concurrentBlobDownloads
    }

    if (typeof copy.downloadConcurrency === 'number') {
      result.downloadConcurrency = copy.downloadConcurrency
    }

    if (typeof copy.timeoutInMs === 'number') {
      result.timeoutInMs = copy.timeoutInMs
    }

    if (typeof copy.segmentTimeoutInMs === 'number') {
      result.segmentTimeoutInMs = copy.segmentTimeoutInMs
    }

    if (typeof copy.lookupOnly === 'boolean') {
      result.lookupOnly = copy.lookupOnly
    }

    if (typeof copy.s3Endpoint === 'string') {
      result.s3Endpoint = copy.s3Endpoint
    }
  }
  const segmentDownloadTimeoutMins =
    process.env['SEGMENT_DOWNLOAD_TIMEOUT_MINS']

  if (
    segmentDownloadTimeoutMins &&
    !isNaN(Number(segmentDownloadTimeoutMins)) &&
    isFinite(Number(segmentDownloadTimeoutMins))
  ) {
    result.segmentTimeoutInMs = Number(segmentDownloadTimeoutMins) * 60 * 1000
  }
  core.debug(`Use S3 SDK: ${result.useS3}`)
  core.debug(`Download concurrency: ${result.downloadConcurrency}`)
  core.debug(`Request timeout (ms): ${result.timeoutInMs}`)
  core.debug(
    `Cache segment download timeout mins env var: ${process.env['SEGMENT_DOWNLOAD_TIMEOUT_MINS']}`
  )
  core.debug(`Segment download timeout (ms): ${result.segmentTimeoutInMs}`)
  core.debug(`Lookup only: ${result.lookupOnly}`)
  if (result.s3Endpoint) {
    core.debug(`S3 endpoint: ${result.s3Endpoint}`)
  }

  return result
}
