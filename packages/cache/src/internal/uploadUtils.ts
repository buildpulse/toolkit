import * as core from '@actions/core'
import {
  S3Client,
  PutObjectCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommandOutput
} from '@aws-sdk/client-s3'
import * as fs from 'fs'
import {InvalidResponseError} from './shared/errors'
import {UploadOptions} from '../options'
import {S3Utils, S3UploadProgress} from './s3Utils'

export class UploadProgress {
  contentLength: number
  sentBytes: number
  startTime: number
  displayedComplete: boolean
  timeoutHandle?: ReturnType<typeof setTimeout>

  constructor(contentLength: number) {
    this.contentLength = contentLength
    this.sentBytes = 0
    this.displayedComplete = false
    this.startTime = Date.now()
  }

  setSentBytes(sentBytes: number): void {
    this.sentBytes = sentBytes
  }

  getTransferredBytes(): number {
    return this.sentBytes
  }

  isDone(): boolean {
    return this.getTransferredBytes() === this.contentLength
  }

  display(): void {
    if (this.displayedComplete) {
      return
    }

    const transferredBytes = this.sentBytes
    const percentage = (100 * (transferredBytes / this.contentLength)).toFixed(
      1
    )
    const elapsedTime = Date.now() - this.startTime
    const uploadSpeed = (
      transferredBytes /
      (1024 * 1024) /
      (elapsedTime / 1000)
    ).toFixed(1)

    core.info(
      `Sent ${transferredBytes} of ${this.contentLength} (${percentage}%), ${uploadSpeed} MBs/sec`
    )

    if (this.isDone()) {
      this.displayedComplete = true
    }
  }

  onProgress(): (progress: S3UploadProgress) => void {
    return (progress: S3UploadProgress) => {
      this.setSentBytes(progress.loadedBytes)
    }
  }

  startDisplayTimer(delayInMs = 1000): void {
    const displayCallback = (): void => {
      this.display()

      if (!this.isDone()) {
        this.timeoutHandle = setTimeout(displayCallback, delayInMs)
      }
    }

    this.timeoutHandle = setTimeout(displayCallback, delayInMs)
  }

  stopDisplayTimer(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = undefined
    }

    this.display()
  }
}

export async function uploadCacheArchiveSDK(
  signedUploadURL: string,
  archivePath: string,
  options?: UploadOptions
): Promise<CompleteMultipartUploadCommandOutput> {
  const s3Utils = new S3Utils()
  const s3Client = s3Utils.getClient()
  const uploadProgress = new UploadProgress(options?.archiveSizeBytes ?? 0)
  const fileSize = fs.statSync(archivePath).size
  const chunkSize = options?.uploadChunkSize ?? 5 * 1024 * 1024
  const maxConcurrency = options?.uploadConcurrency ?? 4

  try {
    uploadProgress.startDisplayTimer()

    const url = new URL(signedUploadURL)
    const bucket = url.hostname.split('.')[0]
    const key = url.pathname.substring(1)

    const createMultipartUpload = await s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key
      })
    )

    const uploadId = createMultipartUpload.UploadId
    if (!uploadId) {
      throw new Error('Failed to get upload ID from S3')
    }

    const numParts = Math.ceil(fileSize / chunkSize)
    const uploadPromises: Promise<void>[] = []
    const uploadedParts: { PartNumber: number; ETag: string }[] = []

    for (let i = 0; i < numParts; i++) {
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, fileSize)
      const partNumber = i + 1

      const chunk = fs.createReadStream(archivePath, { start, end: end - 1 })

      const uploadPartCommand = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: chunk
      })

      uploadPromises.push(
        s3Client.send(uploadPartCommand).then(response => {
          if (!response.ETag) {
            throw new Error(`Failed to get ETag for part ${partNumber}`)
          }
          uploadedParts.push({
            PartNumber: partNumber,
            ETag: response.ETag
          })
          uploadProgress.setSentBytes(
            Math.min(uploadProgress.getTransferredBytes() + chunkSize, fileSize)
          )
        })
      )

      if (uploadPromises.length >= maxConcurrency) {
        await Promise.all(uploadPromises)
        uploadPromises.length = 0
      }
    }

    await Promise.all(uploadPromises)

    const completeMultipartUpload = await s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: uploadedParts.sort((a, b) => a.PartNumber - b.PartNumber)
        }
      })
    )

    return completeMultipartUpload
  } catch (error) {
    core.warning(
      `uploadCacheArchiveSDK: internal error uploading cache archive: ${error.message}`
    )
    throw error
  } finally {
    uploadProgress.stopDisplayTimer()
  }
}
