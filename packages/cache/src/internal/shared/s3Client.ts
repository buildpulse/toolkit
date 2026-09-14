import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
  ListObjectsV2Command
} from '@aws-sdk/client-s3'
import {Readable, pipeline} from 'stream'
import * as utils from '../../internal/cacheUtils'
import {promisify} from 'util'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import {createGunzip} from 'zlib'
import * as zlib from 'zlib'
import * as tar from 'tar'
import * as os from 'os'
import {CompressionMethod} from '../constants'
// Relative, not 'src/options'. The non-relative form only resolved because this
// package's tsconfig sets baseUrl to the package root; anything consuming the
// sources directly -- ts-jest, most obviously -- resolved it against the repo
// root and failed. That is why five of this package's test suites, including
// the only one covering isFeatureAvailable, could not compile.
import {UploadOptions, DownloadOptions} from '../../options'
import {
  CredentialOverrides,
  CredentialSource,
  resolveCredentials,
  resolveRegion
} from './credentials'
import {CacheFailure, classify, describe} from './cacheErrors'

// Add interfaces for cache metadata
interface S3CacheMetadata {
  key: string
  version: string
  creationTime: string
  size: number
}

interface S3CacheEntry {
  exists: boolean
  metadata?: S3CacheMetadata
  downloadUrl?: string
}

interface CacheVersionOptions {
  compressionMethod: CompressionMethod
  enableCrossOsArchive: boolean
}

// eslint-disable-next-line import/no-mutable-exports
export let s3Client: S3Client

/**
 * Where this client's credentials came from. Kept so a denial can name the
 * source that produced the rejected credentials, which is the single most
 * useful fact when one turns up in a log.
 */
let credentialSource: string = CredentialSource.None

export function resolvedCredentialSource(): string {
  return credentialSource
}

/** Test seam: the client and the recorded source are module state. */
export function resetS3Client(): void {
  s3Client = undefined as unknown as S3Client
  credentialSource = CredentialSource.None
}

export function initializeS3Client(
  overrides: CredentialOverrides = {}
): S3Client {
  if (s3Client) {
    return s3Client
  }

  const {region, fromAmbient} = resolveRegion(overrides)
  if (!region) {
    throw new Error(
      'No region for the cache bucket. Set BP_CACHE_AWS_REGION (or AWS_REGION).'
    )
  }

  const resolved = resolveCredentials(overrides)
  credentialSource = resolved.source
  if (!resolved.credentials) {
    throw new Error(
      'No credentials for the cache bucket. Supply them with ' +
        'BP_CACHE_AWS_CREDENTIALS_FILE, or with BP_CACHE_AWS_ACCESS_KEY_ID and ' +
        'BP_CACHE_AWS_SECRET_ACCESS_KEY. The ambient AWS_ACCESS_KEY_ID and ' +
        'AWS_SECRET_ACCESS_KEY are deliberately not used: they belong to the ' +
        'job, not to the cache.'
    )
  }

  core.debug(
    `Cache region ${region}${
      fromAmbient ? ' (from AWS_REGION; prefer BP_CACHE_AWS_REGION)' : ''
    }`
  )
  core.debug(
    `Cache credentials from ${resolved.source}${
      resolved.detail ? ` -- ${resolved.detail}` : ''
    }`
  )

  // The provider is always explicit. Handing the SDK a config with no
  // `credentials` falls back to its default chain, whose first link is the
  // ambient AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY pair -- the exact hijack
  // this resolution exists to prevent.
  s3Client = new S3Client({region, credentials: resolved.credentials})

  return s3Client
}

async function compressData(filePath: string, key: string): Promise<string> {
  const compressedFilePath = path.join(os.tmpdir(), `${path.basename(key)}.gz`)
  const fileContent = await fs.promises.readFile(filePath)

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(compressedFilePath)
    const gzip = zlib.createGzip()

    const readStream = Readable.from(fileContent)
    readStream
      .pipe(gzip)
      .pipe(writeStream)
      .on('finish', () => resolve(compressedFilePath))
      .on('error', reject)
  })
}

async function compressDirectory(
  dirPath: string,
  key: string
): Promise<string> {
  const tempFile = path.join(os.tmpdir(), `${path.basename(key)}.tar.gz`)

  await tar.create(
    {
      gzip: true,
      file: tempFile,
      cwd: path.dirname(dirPath)
    },
    [path.basename(dirPath)]
  )

  return tempFile // Return path of compressed tarball
}

export async function uploadToS3(
  bucketName: string,
  key: string,
  filePath: string,
  options?: UploadOptions,
  enableCrossOsArchive = false
): Promise<void> {
  const s3Key = `${key}:${filePath}`

  const client = initializeS3Client()
  let compressedFilePath: string
  let isCompressed = false

  const startTime = new Date()
  if (fs.statSync(filePath).isDirectory()) {
    compressedFilePath = await compressDirectory(filePath, s3Key)
    isCompressed = true
  } else {
    compressedFilePath = await compressData(filePath, s3Key)
    isCompressed = true
  }
  core.debug(`Compressed in ${new Date().getTime() - startTime.getTime()} ms`)

  const fileSize = fs.statSync(compressedFilePath).size
  const chunkSize = options?.uploadChunkSize || 5 * 1024 * 1024 // 5MB default chunk size

  const cacheEntry: S3CacheEntry = {
    exists: true,
    metadata: {
      key: s3Key,
      version: utils.getCacheVersion(
        [filePath],
        CompressionMethod.Gzip,
        enableCrossOsArchive
      ),
      creationTime: new Date().toISOString(),
      size: fileSize
    }
  }

  if (fileSize <= chunkSize) {
    // Small file, use simple upload
    const fileStream = fs.createReadStream(compressedFilePath)
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      Body: fileStream,
      ContentLength: fileSize,
      Metadata: {
        cacheEntry: JSON.stringify(cacheEntry)
      }
    })

    await client.send(command)
  } else {
    // Multipart upload implementation remains the same
    const multipartUpload = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucketName,
        Key: s3Key,
        Metadata: {
          cacheEntry: JSON.stringify(cacheEntry)
        }
      })
    )

    const uploadId = multipartUpload.UploadId
    const parts: {ETag: string; PartNumber: number}[] = []

    try {
      let partNumber = 1
      const fileStream = fs.createReadStream(compressedFilePath, {
        highWaterMark: chunkSize
      })

      for await (const chunk of fileStream) {
        const uploadPartCommand = new UploadPartCommand({
          Bucket: bucketName,
          Key: s3Key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: chunk
        })

        const {ETag} = await client.send(uploadPartCommand)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        parts.push({ETag: ETag!, PartNumber: partNumber})
        partNumber++
      }

      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucketName,
          Key: s3Key,
          UploadId: uploadId,
          MultipartUpload: {Parts: parts}
        })
      )
    } catch (error) {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucketName,
          Key: s3Key,
          UploadId: uploadId
        })
      )
      throw error
    }
  }

  core.info(
    `Successfully uploaded ${
      isCompressed ? 'compressed ' : ''
    }${filePath} to S3 bucket ${bucketName} with key ${key}`
  )
}

export async function downloadFromS3(
  bucketName: string,
  key: string,
  destinationPath: string,
  options?: DownloadOptions,
  enableCrossOsArchive = false
): Promise<void> {
  const s3Key = `${key}:${destinationPath}`
  const directory = path.dirname(destinationPath)
  const compressedPath = path.join(directory, `compressed-${key}`)
  const archiveDestinationPath = path.join(
    compressedPath,
    path.basename(`${destinationPath}.gz`)
  )
  const client = initializeS3Client()
  const command = new GetObjectCommand({
    Bucket: bucketName,
    Key: s3Key
  })

  try {
    const {Body} = await client.send(command)

    // Parse cache entry from metadata
    const cacheEntry = {
      exists: true,
      metadata: {
        key: s3Key,
        version: utils.getCacheVersion(
          [destinationPath],
          CompressionMethod.Gzip,
          enableCrossOsArchive
        ),
        creationTime: new Date().toISOString(),
        size: 0
      }
    } as S3CacheEntry

    if (Body instanceof Readable) {
      // make 'compressed' directory if it doesn't exist
      if (!fs.existsSync(compressedPath)) {
        fs.mkdirSync(compressedPath, {recursive: true})
      }

      const writeStream = fs.createWriteStream(archiveDestinationPath)

      await promisify(pipeline)(Body, writeStream)

      // Update cache entry size after download
      if (cacheEntry.metadata) {
        cacheEntry.metadata.size = fs.statSync(archiveDestinationPath).size
      }

      const tempUncompressedPath = path.join(
        compressedPath,
        `temp_${path.basename(destinationPath)}`
      )

      core.debug(
        `Uncompressing ${archiveDestinationPath} to ${tempUncompressedPath}`
      )

      // Unzip the .gz file first
      const gunzipStream = createGunzip()
      const startTime = new Date()
      await promisify(pipeline)(
        fs.createReadStream(archiveDestinationPath).pipe(gunzipStream),
        fs.createWriteStream(tempUncompressedPath)
      )
      core.debug(
        `Decompressed in ${new Date().getTime() - startTime.getTime()} ms`
      )

      const isTar = await isTarFile(tempUncompressedPath)
      if (isTar) {
        await promisify(pipeline)(
          fs.createReadStream(tempUncompressedPath),
          tar.extract({cwd: directory})
        )
        core.debug(`Extracted ${tempUncompressedPath} to ${destinationPath}`)
      } else {
        fs.renameSync(tempUncompressedPath, destinationPath)
        core.debug(`Moved ${tempUncompressedPath} to ${destinationPath}`)
      }
    } else {
      throw new Error('Invalid response body from S3')
    }

    core.info(
      `Successfully downloaded cache from S3 bucket '${bucketName}' with key '${key}' at '${destinationPath}'`
    )
  } catch (error) {
    // Rethrown as-is. This used to build a bare Error by stringifying the
    // SDK's, which discarded `name` and `$metadata` -- the only things that
    // tell "nothing is cached under this key" apart from "we are not allowed
    // to read it". The error now reaches the caller intact so it can be
    // classified.
    throw error
  }
}

async function isTarFile(filePath: string): Promise<boolean> {
  const fd = await fs.promises.open(filePath, 'r')
  const buffer = Buffer.alloc(512) // Read the first 512 bytes (tar header size)

  await fd.read(buffer, 0, 512, 0)
  await fd.close()

  // The magic number "ustar" is located at byte positions 257-262
  const tarMagic = buffer.toString('ascii', 257, 262)

  return tarMagic === 'ustar'
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function isTarGz(filePath: string): Promise<boolean> {
  const fd = await fs.promises.open(filePath, 'r')
  const buffer = Buffer.alloc(262)
  await fd.read(buffer, 0, 262, 0)

  await fd.close()
  const isGzip = buffer[0] === 0x1f && buffer[1] === 0x8b
  const isTar = buffer.toString('ascii', 257, 262) === 'ustar'
  return isGzip && isTar
}

export async function getCacheEntry(
  bucketName: string,
  key: string, // s3Key
  paths: string[],
  options: CacheVersionOptions
): Promise<S3CacheEntry> {
  const client = initializeS3Client()
  const version = utils.getCacheVersion(
    paths,
    options.compressionMethod,
    options.enableCrossOsArchive
  )

  try {
    const command = new HeadObjectCommand({
      Bucket: bucketName,
      Key: key
    })
    const response = await client.send(command)

    return {
      exists: true,
      metadata: {
        key,
        version,
        creationTime:
          response.LastModified?.toISOString() || new Date().toISOString(),
        size: response.ContentLength || 0
      }
    }
  } catch (error) {
    // Only an actual miss is absorbed. Matching on the literal name 'NotFound'
    // meant a 404 reported under any other name became a hard error, and -- far
    // worse in the other direction -- left every non-miss to be swallowed
    // further up as though it were one.
    if (classify(error) === CacheFailure.Miss) {
      return {exists: false}
    }
    throw error
  }
}

export async function listCacheEntries(
  bucketName: string,
  prefix: string
): Promise<S3CacheMetadata[]> {
  const client = initializeS3Client()
  const command = new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: prefix
  })

  try {
    const response = await client.send(command)
    const entries: S3CacheMetadata[] = []

    core.debug(
      `Found ${response.Contents
        ?.length} cache entries with restore keys: ${response.Contents?.map(
        object => object.Key
      ).join(', ')}`
    )

    for (const object of response.Contents || []) {
      const key = object.Key || ''
      const parts = key.split(':')

      if (parts.length >= 2) {
        entries.push({
          key: parts[0],
          version: parts[1],
          creationTime:
            object.LastModified?.toISOString() || new Date().toISOString(),
          size: object.Size || 0
        })
      }
    }

    return entries
  } catch (error) {
    // A denied ListObjectsV2 returns no entries, which is indistinguishable
    // from a restore key that genuinely matches nothing. That is the precise
    // shape of the silent failure this change exists to remove, so a denial is
    // raised rather than logged and flattened to an empty list.
    if (classify(error) === CacheFailure.Auth) {
      throw error
    }
    core.warning(`Failed to list cache entries: ${describe(error)}`)
    return []
  }
}

export async function lookupCache(
  bucketName: string,
  key: string, // s3Key
  paths: string[],
  restoreKeys: string[],
  options: CacheVersionOptions
): Promise<S3CacheEntry | undefined> {
  // Try exact match first
  const exactMatch = await getCacheEntry(bucketName, key, paths, options)
  if (exactMatch.exists) {
    return exactMatch
  }

  core.debug(
    `No exact match found. Using restore keys: ${restoreKeys.join(', ')}`
  )

  // Try restore keys
  for (const restoreKey of restoreKeys) {
    const entries = await listCacheEntries(bucketName, restoreKey)

    core.debug(
      `Serialized ${entries.length} cache entries with restore keys: ${entries
        .map(entry => `${entry.key} (${entry.creationTime})`)
        .join(', ')}`
    )

    if (entries.length > 0) {
      // Return the most recent matching cache
      const latest = entries.sort(
        (a, b) =>
          new Date(b.creationTime).getTime() -
          new Date(a.creationTime).getTime()
      )[0]

      core.debug(
        `Found latest entry from restore keys: ${latest.key} (${latest.creationTime})`
      )

      return {
        exists: true,
        metadata: latest
      }
    }
  }

  return undefined
}
