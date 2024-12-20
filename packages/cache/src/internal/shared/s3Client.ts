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
import * as exec from '@actions/exec'
import * as utils from '../../internal/cacheUtils'
import {promisify} from 'util'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {CompressionMethod} from '../constants'
import {UploadOptions, DownloadOptions} from 'src/options'

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

export function initializeS3Client(): S3Client {
  if (s3Client) {
    return s3Client
  }

  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const region = process.env.AWS_REGION

  if (!accessKeyId || !secretAccessKey || !region) {
    throw new Error('AWS credentials or region not provided')
  }

  s3Client = new S3Client({
    credentials: {
      accessKeyId,
      secretAccessKey
    },
    region
  })

  return s3Client
}

async function compressData(filePath: string, key: string): Promise<string> {
  const compressedFilePath = path.join(os.tmpdir(), `${path.basename(key)}.gz`)

  const writeStream = fs.createWriteStream(compressedFilePath)
  const startTime = new Date()
  await exec.exec('pigz', ['-9', '-c', filePath], {
    listeners: {
      stdout: (data: Buffer) => writeStream.write(data)
    },
    silent: true
  })

  core.debug(
    `Compressed ${filePath} in ${new Date().getTime() - startTime.getTime()} ms`
  )

  return compressedFilePath
}

async function compressDirectory(
  dirPath: string,
  key: string
): Promise<string> {
  const tempDir = os.tmpdir()
  const tarFile = path.join(tempDir, `${path.basename(key)}.tar`)
  const compressedFile = path.join(tempDir, `${path.basename(key)}.tar.gz`)

  // Create tar and pipe to pigz for compression
  const tarStream = fs.createWriteStream(tarFile)
  await exec.exec('tar', ['-cf', '-', dirPath], {
    outStream: tarStream,
    silent: true
  })

  const writeStream = fs.createWriteStream(compressedFile)
  const startTime = new Date()
  await exec.exec('pigz', ['-9', '-f', tarFile], {
    listeners: {
      stdout: (data: Buffer) => writeStream.write(data)
    },
    silent: true
  })
  writeStream.end()

  core.debug(
    `Compressed ${dirPath} in ${new Date().getTime() - startTime.getTime()} ms`
  )

  return compressedFile
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

  if (fs.statSync(filePath).isDirectory()) {
    compressedFilePath = await compressDirectory(filePath, s3Key)
    isCompressed = true
  } else {
    compressedFilePath = await compressData(filePath, s3Key)
    isCompressed = true
  }

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

      const tempDecompressedPath = path.join(
        compressedPath,
        `temp_${path.basename(destinationPath)}`
      )

      core.debug(
        `Decompressing ${archiveDestinationPath} to ${tempDecompressedPath}`
      )

      const uncompressWriteStream = fs.createWriteStream(tempDecompressedPath)

      const startTime = new Date()
      await exec.exec('pigz', ['-dc', archiveDestinationPath], {
        listeners: {
          stdout: (data: Buffer) => uncompressWriteStream.write(data)
        },
        silent: true
      })
      uncompressWriteStream.close()

      core.debug(
        `Decompressed in ${new Date().getTime() - startTime.getTime()} ms`
      )
    } else {
      throw new Error('Invalid response body from S3')
    }

    core.info(
      `Successfully downloaded cache from S3 bucket '${bucketName}' with key '${key}' at '${destinationPath}'`
    )
  } catch (error) {
    throw new Error(`Failed to download cache from S3: ${error}`)
  }
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
    if (error.name === 'NotFound') {
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

    for (const object of response.Contents || []) {
      const key = object.Key || ''
      const parts = key.split('-')

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
    core.warning(`Failed to list cache entries: ${error}`)
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

  // Try restore keys
  for (const restoreKey of restoreKeys) {
    const entries = await listCacheEntries(bucketName, restoreKey)
    if (entries.length > 0) {
      // Return the most recent matching cache
      const latest = entries.sort(
        (a, b) =>
          new Date(b.creationTime).getTime() -
          new Date(a.creationTime).getTime()
      )[0]

      return {
        exists: true,
        metadata: latest
      }
    }
  }

  return undefined
}
