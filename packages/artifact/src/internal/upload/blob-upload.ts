import {ZipUploadStream} from './zip'
import * as core from '@actions/core'
import {uploadZipToS3} from './s3-upload'

export interface BlobUploadResponse {
  /**
   * The total reported upload size in bytes. Empty if the upload failed
   */
  uploadSize?: number

  /**
   * The SHA256 hash of the uploaded file. Empty if the upload failed
   */
  sha256Hash?: string
}

export async function uploadZipToBlobStorage(
  authenticatedUploadURL: string,
  zipUploadStream: ZipUploadStream
): Promise<BlobUploadResponse> {
  core.info('Beginning upload of artifact content')
  const response = await uploadZipToS3(authenticatedUploadURL, zipUploadStream)
  core.info('Finished uploading artifact content!')
  return response
}
