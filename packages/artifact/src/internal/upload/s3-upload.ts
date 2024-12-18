import {
  S3Client,
  PutObjectCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand
} from '@aws-sdk/client-s3'
import { ZipUploadStream } from './zip'
import { S3UploadResponse } from './s3-types'
import { S3UploadError } from '../shared/errors'
import * as crypto from 'crypto'
import * as stream from 'stream'

export async function uploadZipToS3(
  signedUrl: string,
  zipUploadStream: ZipUploadStream
): Promise<S3UploadResponse> {
  const s3Client = new S3Client({})
  const chunkSize = 5 * 1024 * 1024 // 5MB chunks
  const maxConcurrency = 4
  let uploadSize = 0
  let lastProgressTime = Date.now()
  const stallTimeout = 30000 // 30 seconds

  // Create hash stream for SHA256 calculation
  const hashStream = crypto.createHash('sha256')
  zipUploadStream.pipe(hashStream).setEncoding('hex')

  try {
    const url = new URL(signedUrl)
    const bucket = url.hostname.split('.')[0]
    const key = url.pathname.substring(1)

    // Start multipart upload
    let uploadId: string
    try {
      const createMultipartUpload = await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          ContentType: 'application/zip'
        })
      )
      if (!createMultipartUpload.UploadId) {
        throw new S3UploadError('Failed to get upload ID from S3')
      }
      uploadId = createMultipartUpload.UploadId
    } catch (error) {
      throw new S3UploadError(
        `Failed to initiate multipart upload: ${S3UploadError.getErrorMessage(error)}`,
        'CREATE_MULTIPART_FAILED'
      )
    }

    const uploadPromises: Promise<void>[] = []
    const uploadedParts: { PartNumber: number; ETag: string }[] = []
    let partNumber = 1
    let isStreamComplete = false

    // Process the stream in chunks
    while (!isStreamComplete) {
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0

        const onData = (data: Buffer) => {
          chunks.push(data)
          size += data.length
          lastProgressTime = Date.now()

          if (size >= chunkSize) {
            cleanup()
            resolve(Buffer.concat(chunks))
          }
        }

        const onEnd = () => {
          cleanup()
          isStreamComplete = true
          if (chunks.length > 0) {
            resolve(Buffer.concat(chunks))
          } else {
            resolve(Buffer.alloc(0))
          }
        }

        const onError = (err: Error) => {
          cleanup()
          reject(err)
        }

        const cleanup = () => {
          zipUploadStream.removeListener('data', onData)
          zipUploadStream.removeListener('end', onEnd)
          zipUploadStream.removeListener('error', onError)
        }

        zipUploadStream.on('data', onData)
        zipUploadStream.on('end', onEnd)
        zipUploadStream.on('error', onError)

        // Check for stalled upload
        const checkStall = setInterval(() => {
          if (Date.now() - lastProgressTime > stallTimeout) {
            clearInterval(checkStall)
            cleanup()
            reject(new Error('Upload progress stalled.'))
          }
        }, 1000)

        // Clean up stall checker on success
        zipUploadStream.once('end', () => clearInterval(checkStall))
      })

      if (chunk.length === 0 && isStreamComplete) {
        break
      }

      uploadSize += chunk.length
      console.log(`Uploaded bytes ${uploadSize}`)

      try {
        const uploadPartCommand = new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        })

        uploadPromises.push(
          s3Client.send(uploadPartCommand).then(response => {
            if (!response.ETag) {
              throw new S3UploadError(
                `Failed to get ETag for part ${partNumber}`,
                'MISSING_ETAG'
              )
            }
            uploadedParts.push({
              PartNumber: partNumber,
              ETag: response.ETag
            })
            lastProgressTime = Date.now() // Update progress time after successful part upload
          })
        )

        if (uploadPromises.length >= maxConcurrency) {
          await Promise.all(uploadPromises).catch(error => {
            throw new S3UploadError(
              `Failed to upload part ${partNumber}: ${S3UploadError.getErrorMessage(error)}`,
              'UPLOAD_PART_FAILED'
            )
          })
          uploadPromises.length = 0
        }

        partNumber++
      } catch (error) {
        throw new S3UploadError(
          `Failed to upload part ${partNumber}: ${S3UploadError.getErrorMessage(error)}`,
          'UPLOAD_PART_FAILED'
        )
      }
    }

    // Wait for any remaining uploads to complete
    try {
      await Promise.all(uploadPromises)
    } catch (error) {
      throw new S3UploadError(
        `Failed to complete remaining uploads: ${S3UploadError.getErrorMessage(error)}`,
        'UPLOAD_PARTS_FAILED'
      )
    }

    // Complete the multipart upload
    try {
      await s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: uploadedParts.sort((a, b) => a.PartNumber - b.PartNumber)
          }
        })
      )
    } catch (error) {
      throw new S3UploadError(
        `Failed to complete multipart upload: ${S3UploadError.getErrorMessage(error)}`,
        'COMPLETE_MULTIPART_FAILED'
      )
    }

    // Get the SHA256 hash
    hashStream.end()
    const sha256Hash = hashStream.read() as string
    console.log(`SHA256 hash of uploaded artifact zip is ${sha256Hash}`)

    if (uploadSize === 0) {
      throw new S3UploadError('No data was uploaded to S3', 'ZERO_BYTES_UPLOADED')
    }

    return {
      uploadSize,
      sha256Hash
    }
  } catch (error) {
    if (error.message === 'Upload progress stalled.') {
      throw error // Pass through stall errors directly
    }
    if (S3UploadError.isS3Error(error)) {
      throw error
    }
    throw new S3UploadError(
      `Unexpected error uploading to S3: ${error.message}`,
      'UNEXPECTED_ERROR'
    )
  }
}
