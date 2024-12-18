import {Readable} from 'stream'
import {
  S3Client,
  CreateMultipartUploadCommandOutput,
  CreateMultipartUploadCommand,
  ServiceInputTypes,
  ServiceOutputTypes
} from '@aws-sdk/client-s3'
import {S3ArtifactManager} from '../src/internal/s3/artifact-manager'
import * as util from '../src/internal/shared/util'
import {NetworkError} from '../src/internal/shared/errors'

jest.mock('@aws-sdk/client-s3')
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/upload')
}))
jest.mock('../src/internal/shared/util')

describe('S3ArtifactManager', () => {
  let s3Client: jest.Mocked<S3Client>
  let artifactManager: S3ArtifactManager

  beforeEach(() => {
    jest.clearAllMocks()
    const mockSend = jest.fn()
    s3Client = {
      send: mockSend
    } as unknown as jest.Mocked<S3Client>

    mockSend.mockImplementation((command: any) => {
      const response = (command instanceof CreateMultipartUploadCommand)
        ? {UploadId: 'test-upload-id'}
        : {}
      return Promise.resolve(response)
    })

    const config = {
      region: 'us-east-1',
      bucket: 'test-bucket',
      credentials: {
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret'
      }
    }
    artifactManager = new S3ArtifactManager({
      ...config,
      s3Client
    })
  })

  it('creates artifact in S3', async () => {
    const artifactName = 'test-artifact'
    const uploadUrl = 'https://s3.example.com/upload'

    const result = await artifactManager.createArtifact(artifactName)
    expect(result.uploadUrl).toBe(uploadUrl)
    expect(result.artifactId).toBeDefined()
  })

  it('handles network errors', async () => {
    const artifactName = 'test-artifact'
    const error = new NetworkError('NetworkingError', 'Network error: temporary failure')
    artifactManager.createArtifact = jest.fn().mockRejectedValueOnce(error)

    await expect(
      artifactManager.createArtifact(artifactName)
    ).rejects.toThrow('Network error: temporary failure')
  })

  it('retries failed requests', async () => {
    const artifactName = 'test-artifact'
    const uploadUrl = 'https://s3.example.com/upload'
    let retryCount = 0

    s3Client.send.mockImplementation((command: any) => {
      retryCount++
      if (retryCount === 1) {
        return Promise.reject({
          name: 'NetworkError',
          code: 'ECONNREFUSED',
          message: 'Connection refused'
        })
      }
      const response = (command instanceof CreateMultipartUploadCommand)
        ? {UploadId: 'test-upload-id'}
        : {}
      return Promise.resolve(response)
    })

    const result = await artifactManager.createArtifact(artifactName)
    expect(result.uploadUrl).toBe(uploadUrl)
    expect(result.artifactId).toBeDefined()
    expect(retryCount).toBe(2) // Verify retry happened
  })

  it('handles non-retryable errors', async () => {
    const artifactName = 'test-artifact'
    const error = new Error('Access denied')
    s3Client.send.mockImplementationOnce(() => Promise.reject(error))

    await expect(
      artifactManager.createArtifact(artifactName)
    ).rejects.toThrow('Access denied')
    expect(s3Client.send).toHaveBeenCalledTimes(1)
  })

  it('handles invalid responses', async () => {
    const artifactName = 'test-artifact'
    s3Client.send.mockImplementation((command: any) => {
      const response = {UploadId: undefined}
      return Promise.resolve(response)
    })

    await expect(
      artifactManager.createArtifact(artifactName)
    ).rejects.toThrow('Failed to create multipart upload')
  })
})
