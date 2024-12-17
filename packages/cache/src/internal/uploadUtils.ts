import * as core from '@actions/core'
import {UploadOptions} from '../options'
import {uploadToS3} from './s3Utils'
import {Progress} from '@aws-sdk/lib-storage'

/**
 * Class for tracking the upload state and displaying stats.
 */
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
   * Returns a function used to handle Progress events.
   */
  onProgress(): (progress: Progress) => void {
    return (progress: Progress) => {
      this.setSentBytes(progress.loaded ?? 0)
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
 * Uploads a cache archive to S3.
 * This function will display progress information to the console.
 *
 * @param bucket The S3 bucket name
 * @param key The S3 object key
 * @param archivePath Path to the archive file to upload
 * @param options Upload options
 */
export async function uploadCacheArchive(
  bucket: string,
  key: string,
  archivePath: string,
  options?: UploadOptions
): Promise<void> {
  const uploadProgress = new UploadProgress(options?.archiveSizeBytes ?? 0)

  try {
    uploadProgress.startDisplayTimer()

    await uploadToS3(bucket, key, archivePath, {
      partSize: options?.uploadChunkSize,
      queueSize: options?.uploadConcurrency
    })

    return
  } catch (error) {
    core.warning(
      `uploadCacheArchive: internal error uploading cache archive: ${error.message}`
    )
    throw error
  } finally {
    uploadProgress.stopDisplayTimer()
  }
}
