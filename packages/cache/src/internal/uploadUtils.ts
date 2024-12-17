import * as core from '@actions/core'
import {getS3Client, uploadToS3, isS3Url} from './s3Utils'
import {S3Client} from '@aws-sdk/client-s3'
import {UploadOptions} from '../options'

/**
 * Interface for tracking upload progress events
 */
interface TransferProgressEvent {
  loadedBytes: number
}

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

  /**
   * Sets the number of bytes sent
   *
   * @param sentBytes the number of bytes sent
   */
  setSentBytes(sentBytes: number): void {
    this.sentBytes = sentBytes
  }

  /**
   * Returns the total number of bytes transferred.
   */
  getTransferredBytes(): number {
    return this.sentBytes
  }

  /**
   * Returns true if the upload is complete.
   */
  isDone(): boolean {
    return this.getTransferredBytes() === this.contentLength
  }

  /**
   * Prints the current upload stats. Once the upload completes, this will print one
   * last line and then stop.
   */
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

  /**
   * Returns a function used to handle TransferProgressEvents.
   */
  onProgress(): (progress: TransferProgressEvent) => void {
    return (progress: TransferProgressEvent): void => {
      this.setSentBytes(progress.loadedBytes)
    }
  }

  /**
   * Starts the timer that displays the stats.
   *
   * @param delayInMs the delay between each write
   */
  startDisplayTimer(delayInMs = 1000): void {
    const displayCallback = (): void => {
      this.display()

      if (!this.isDone()) {
        this.timeoutHandle = setTimeout(displayCallback, delayInMs)
      }
    }

    this.timeoutHandle = setTimeout(displayCallback, delayInMs)
  }

  /**
   * Stops the timer that displays the stats. As this typically indicates the upload
   * is complete, this will display one last line, unless the last line has already
   * been written.
   */
  stopDisplayTimer(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle)
      this.timeoutHandle = undefined
    }

    this.display()
  }
}

/**
 * Uploads a cache archive directly to S3 using the AWS SDK.
 * This function will display progress information to the console. Concurrency of the
 * upload is determined by the calling functions.
 *
 * @param signedUploadURL
 * @param archivePath
 * @param options
 */
export async function uploadCacheArchiveSDK(
  signedUploadURL: string,
  archivePath: string,
  options?: UploadOptions
): Promise<void> {
  if (!isS3Url(signedUploadURL)) {
    throw new Error('Invalid S3 URL provided for upload')
  }

  const s3Client: S3Client = getS3Client()
  const uploadProgress = new UploadProgress(options?.archiveSizeBytes ?? 0)

  core.debug(
    `Starting upload to S3 with concurrency: ${
      options?.uploadConcurrency
    }, chunk size: ${options?.uploadChunkSize}`
  )

  try {
    uploadProgress.startDisplayTimer()

    await uploadToS3(s3Client, archivePath, signedUploadURL, bytes =>
      uploadProgress.setSentBytes(bytes)
    )

    core.info('Upload to S3 completed successfully')
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Upload was aborted due to timeout')
    }
    core.warning(
      `uploadCacheArchiveSDK: internal error uploading cache archive: ${error.message}`
    )
    throw error
  } finally {
    uploadProgress.stopDisplayTimer()
  }
}
