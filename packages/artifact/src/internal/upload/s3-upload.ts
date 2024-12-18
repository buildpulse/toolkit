import * as core from '@actions/core'
import {
  S3Client,
  PutObjectCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand
} from '@aws-sdk/client-s3'
import { ZipUploadStream } from './zip'
import { BlobUploadResponse } from './blob-upload'
import * as crypto from 'crypto'
import * as stream from 'stream'

export async function uploadZipToS3(
  signedUrl: string,
  zipUploadStream: ZipUploadStream
): Promise<BlobUploadResponse> {
  const s3Client = new S3Client({})
  const chunkSize = 5 * 1024 * 1024 // 5MB chunks
  const maxConcurrency = 4
  let uploadSize = 0

  // Create hash stream for SHA256 calculation
  const hashStream = crypto.createHash('sha256')
  zipUploadStream.pipe(hashStream).setEncoding('hex')

  try {
    const url = new URL(signedUrl)
    const bucket = url.hostname.split('.')[0]
    const key = url.pathname.substring(1)

    // Start multipart upload
    const createMultipartUpload = await s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'zip'
      })
    )

    const uploadId = createMultipartUpload.UploadId
    if (!uploadId) {
      throw new Error('Failed to get upload ID from S3')
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
      })

      if (chunk.length === 0 && isStreamComplete) {
        break
      }

      uploadSize += chunk.length
      core.info(`Uploaded bytes ${uploadSize}`)

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
        })
      )

      if (uploadPromises.length >= maxConcurrency) {
        await Promise.all(uploadPromises)
        uploadPromises.length = 0
      }

      partNumber++
    }

    // Wait for any remaining uploads to complete
    await Promise.all(uploadPromises)

    // Complete the multipart upload
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

    // Get the SHA256 hash
    hashStream.end()
    const sha256Hash = hashStream.read() as string
    core.info(`SHA256 hash of uploaded artifact zip is ${sha256Hash}`)

    if (uploadSize === 0) {
      core.warning('No data was uploaded to S3. Reported upload byte count is 0.')
    }

    return {
      uploadSize,
      sha256Hash
    }
  } catch (error) {
    core.warning(
      `uploadZipToS3: internal error uploading zip archive: ${error.message}`
    )
    throw error
  }
}
