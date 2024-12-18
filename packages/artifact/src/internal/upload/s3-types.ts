/**
 * Response type for S3 artifact uploads
 */
export interface S3UploadResponse {
  /**
   * Size of the uploaded artifact in bytes
   */
  uploadSize: number

  /**
   * SHA256 hash of the uploaded artifact
   */
  sha256Hash?: string
}
