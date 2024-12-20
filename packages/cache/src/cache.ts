import * as core from '@actions/core'
import * as utils from './internal/cacheUtils'
import * as s3Client from './internal/shared/s3Client'
import {DownloadOptions, UploadOptions} from './options'
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
    Object.setPrototypeOf(this, ValidationError.prototype)
  }
}

export class ReserveCacheError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReserveCacheError'
    Object.setPrototypeOf(this, ReserveCacheError.prototype)
  }
}

function checkPaths(paths: string[]): void {
  if (!paths || paths.length === 0) {
    throw new ValidationError(
      `Path Validation Error: At least one directory or file path is required`
    )
  }
}

function checkKey(key: string): void {
  if (key.length > 512) {
    throw new ValidationError(
      `Key Validation Error: ${key} cannot be larger than 512 characters.`
    )
  }
  const regex = /^[^,]*$/
  if (!regex.test(key)) {
    throw new ValidationError(
      `Key Validation Error: ${key} cannot contain commas.`
    )
  }
}

// Add S3 configuration helper
function getS3Config(): {bucketName: string} {
  const bucketName = process.env.BP_CACHE_S3_BUCKET
  if (!bucketName) {
    throw new Error('BP_CACHE_S3_BUCKET environment variable is not set')
  }
  return {bucketName}
}

/**
 * isFeatureAvailable to check the presence of Actions cache service
 *
 * @returns boolean return true if Actions cache service feature is available, otherwise false
 */
export function isFeatureAvailable(): boolean {
  return !!(
    process.env['ACTIONS_CACHE_URL'] || // Original cache service
    (process.env['AWS_ACCESS_KEY_ID'] &&
      process.env['AWS_SECRET_ACCESS_KEY'] &&
      process.env['AWS_REGION'] &&
      process.env['BP_CACHE_S3_BUCKET'])
  )
}

/**
 * Restores cache from keys
 *
 * @param paths a list of file paths to restore from the cache
 * @param primaryKey an explicit key for restoring the cache. Lookup is done with prefix matching.
 * @param restoreKeys an optional ordered list of keys to use for restoring the cache if no cache hit occurred for primaryKey
 * @param downloadOptions cache download options
 * @param enableCrossOsArchive an optional boolean enabled to restore on windows any cache created on any platform
 * @returns string returns the key for the cache hit, otherwise returns undefined
 */
export async function restoreCache(
  paths: string[],
  primaryKey: string,
  restoreKeys?: string[],
  options?: DownloadOptions,
  enableCrossOsArchive = false
): Promise<string | undefined> {
  checkPaths(paths)

  return await restoreCacheV2(
    paths,
    primaryKey,
    restoreKeys,
    options,
    enableCrossOsArchive
  )
}

/**
 * Restores cache using Cache Service v2
 *
 * @param paths a list of file paths to restore from the cache
 * @param primaryKey an explicit key for restoring the cache. Lookup is done with prefix matching
 * @param restoreKeys an optional ordered list of keys to use for restoring the cache if no cache hit occurred for primaryKey
 * @param downloadOptions cache download options
 * @param enableCrossOsArchive an optional boolean enabled to restore on windows any cache created on any platform
 * @returns string returns the key for the cache hit, otherwise returns undefined
 */
async function restoreCacheV2(
  paths: string[],
  primaryKey: string,
  restoreKeys?: string[],
  options?: DownloadOptions,
  enableCrossOsArchive = false
): Promise<string | undefined> {
  try {
    const s3Config = getS3Config()
    const compressionMethod = await utils.getCompressionMethod()

    const cachePaths = await utils.constructPaths(paths)
    for (const cachePath of cachePaths) {
      const s3Key = `${primaryKey}:${cachePath}`

      const cacheEntry = await s3Client.lookupCache(
        s3Config.bucketName,
        s3Key,
        cachePaths,
        restoreKeys || [],
        {
          compressionMethod,
          enableCrossOsArchive
        }
      )

      if (!cacheEntry?.exists) {
        core.info(
          `Cache not found for input keys: ${[
            primaryKey,
            ...(restoreKeys || [])
          ].join(', ')} and paths: ${cachePaths.join(', ')}`
        )

        return undefined
      }
    }

    if (options?.lookupOnly) {
      core.info('Lookup only - skipping download')
      return primaryKey
    }

    for (const cachePath of cachePaths) {
      await s3Client.downloadFromS3(s3Config.bucketName, primaryKey, cachePath)
    }

    core.info('Cache restored successfully')

    return primaryKey
  } catch (error) {
    const typedError = error as Error
    if (typedError.name === ValidationError.name) {
      throw error
    } else {
      core.warning(`Failed to restore: ${typedError.message}`)
    }

    return undefined
  }
}

/**
 * Saves a list of files with the specified key
 *
 * @param paths a list of file paths to be cached
 * @param key an explicit key for restoring the cache
 * @param enableCrossOsArchive an optional boolean enabled to save cache on windows which could be restored on any platform
 * @param options cache upload options
 * @returns number returns cacheId if the cache was saved successfully and throws an error if save fails
 */
export async function saveCache(
  paths: string[],
  key: string,
  options?: UploadOptions,
  enableCrossOsArchive = false
): Promise<number> {
  core.debug('saveCache called')
  checkPaths(paths)
  checkKey(key)

  return await saveCacheV2(paths, key, options, enableCrossOsArchive)
}

/**
 * Save cache using Cache Service v2
 *
 * @param paths a list of file paths to restore from the cache
 * @param key an explicit key for restoring the cache
 * @param options cache upload options
 * @param enableCrossOsArchive an optional boolean enabled to save cache on windows which could be restored on any platform
 * @returns
 */
async function saveCacheV2(
  paths: string[],
  key: string,
  options?: UploadOptions,
  enableCrossOsArchive = false
): Promise<number> {
  // Use S3 if configured
  const s3Config = getS3Config()

  const cachePaths = await utils.resolvePaths(paths)

  core.info(`Paths: ${paths} \nResolved Paths: ${cachePaths}`)
  if (cachePaths.length === 0) {
    throw new Error(
      'Path Validation Error: Path(s) specified in the action for caching do(es) not exist'
    )
  }

  let success = 1
  for (const cachePath of cachePaths) {
    try {
      await s3Client.uploadToS3(
        s3Config.bucketName,
        key,
        cachePath,
        options,
        enableCrossOsArchive
      )
      core.info('Cache saved successfully')
    } catch (error) {
      const typedError = error as Error
      success = 0

      if (typedError.name === ValidationError.name) {
        throw error
      } else {
        core.warning(`Failed to save: ${typedError.message}`)
      }
    }
  }

  return success
}
