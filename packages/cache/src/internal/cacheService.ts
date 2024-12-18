import * as core from '@actions/core'
import * as utils from './cacheUtils'
import {S3Utils} from './s3Utils'
import {CacheEntry} from '../generated/results/entities/v1/cacheentry'
import {CacheMetadata} from '../generated/results/entities/v1/cachemetadata'
import {
  CreateCacheEntryRequest,
  FinalizeCacheEntryUploadRequest,
  FinalizeCacheEntryUploadResponse,
  GetCacheEntryDownloadURLRequest
} from '../generated/results/api/v1/cache'

/**
 * Cache service client that handles both S3 and legacy HTTP operations
 */
export class CacheService {
  private readonly s3Utils: S3Utils

  constructor() {
    this.s3Utils = new S3Utils()
  }

  /**
   * Creates a new cache entry
   * @param key Cache key
   * @param version Cache version
   * @returns Cache entry details including upload URL
   */
  async createCacheEntry(
    key: string,
    version: string
  ): Promise<{cacheId: number; uploadUrl: string}> {
    const metadata: CacheMetadata = {
      repositoryId: process.env.GITHUB_REPOSITORY_ID || '0',
      scope: []
    }

    const request: CreateCacheEntryRequest = {
      key,
      version,
      metadata
    }

    // Generate pre-signed upload URL using S3
    const uploadUrl = await this.s3Utils.generateUploadUrl(key, version)

    // For now, use a timestamp as cache ID since we're moving away from the cache service
    const cacheId = Date.now()

    return {
      cacheId,
      uploadUrl
    }
  }

  /**
   * Finalizes a cache entry upload
   * @param key Cache key
   * @param version Cache version
   * @param size Size of the cache in bytes
   */
  async finalizeCacheEntry(
    key: string,
    version: string,
    size: number
  ): Promise<FinalizeCacheEntryUploadResponse> {
    const request: FinalizeCacheEntryUploadRequest = {
      key,
      version,
      sizeBytes: size.toString(),
      metadata: {
        repositoryId: process.env.GITHUB_REPOSITORY_ID || '0',
        scope: []
      }
    }


    // Since we're using S3 directly, return success with the key as the entry ID
    return {
      ok: true,
      entryId: key
    }
  }

  /**
   * Gets the download URL for a cache entry
   * @param key Primary cache key
   * @param restoreKeys Additional restore keys
   * @param version Cache version
   */
  async getCacheEntryDownloadUrl(
    key: string,
    restoreKeys: string[],
    version: string
  ): Promise<{ok: boolean; matchedKey?: string; signedDownloadUrl?: string}> {
    const request: GetCacheEntryDownloadURLRequest = {
      key,
      restoreKeys,
      version,
      metadata: {
        repositoryId: process.env.GITHUB_REPOSITORY_ID || '0',
        scope: []
      }
    }

    // Try primary key first
    let downloadUrl = await this.s3Utils.generateDownloadUrl(key, version)
    if (downloadUrl) {
      return {
        ok: true,
        matchedKey: key,
        signedDownloadUrl: downloadUrl
      }
    }

    // Try restore keys
    for (const restoreKey of restoreKeys) {
      downloadUrl = await this.s3Utils.generateDownloadUrl(restoreKey, version)
      if (downloadUrl) {
        return {
          ok: true,
          matchedKey: restoreKey,
          signedDownloadUrl: downloadUrl
        }
      }
    }

    return {ok: false}
  }

  /**
   * Gets a cache entry by key
   * @param keys Cache keys to try
   * @param paths Paths used for versioning
   * @param options Additional options
   */
  async getCacheEntry(
    keys: string[],
    paths: string[],
    options: {
      compressionMethod?: string
      enableCrossOsArchive?: boolean
    }
  ): Promise<CacheEntry | null> {
    const version = utils.getCacheVersion(
      paths,
      options.compressionMethod as any,
      options.enableCrossOsArchive
    )

    // Try each key
    for (const key of keys) {
      const downloadUrl = await this.s3Utils.generateDownloadUrl(key, version)
      if (downloadUrl) {
        const entry: CacheEntry = {
          key,
          hash: '', // Not needed for S3
          sizeBytes: '0', // Size will be determined during download
          scope: '',
          version,
          createdAt: undefined,
          lastAccessedAt: undefined,
          expiresAt: undefined
        }
        return entry
      }
    }

    return null
  }
}
