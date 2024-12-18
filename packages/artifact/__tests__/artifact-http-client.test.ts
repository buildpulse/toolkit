import {S3ArtifactManager} from '../src/internal/s3/artifact-manager'
import * as util from '../src/internal/shared/util'
import {NetworkError} from '../src/internal/shared/errors'

jest.mock('../src/internal/s3/artifact-manager')
jest.mock('../src/internal/shared/util')

describe('S3ArtifactManager', () => {
  let mockS3ArtifactManager: jest.Mocked<S3ArtifactManager>

  beforeEach(() => {
    jest.clearAllMocks()
    mockS3ArtifactManager = jest.mocked(new S3ArtifactManager({} as any))
    mockS3ArtifactManager.getSignedDownloadUrl.mockResolvedValue('https://s3.example.com/download')
    mockS3ArtifactManager.getArtifact.mockResolvedValue({
      id: 123,
      name: 'test-artifact',
      size: 100,
      createdAt: new Date()
    })
    mockS3ArtifactManager.listArtifacts.mockResolvedValue([])
    mockS3ArtifactManager.createArtifact.mockResolvedValue({
      uploadUrl: 'https://example.com',
      artifactId: 123
    })
    mockS3ArtifactManager.deleteArtifact.mockResolvedValue({id: 123})
    mockS3ArtifactManager.uploadArtifact.mockResolvedValue({
      uploadSize: 100,
      sha256Hash: 'hash'
    })
    mockS3ArtifactManager.finalizeArtifact.mockResolvedValue()
    jest.spyOn(util, 'getArtifactManager').mockReturnValue(mockS3ArtifactManager)
  })

  it('creates artifact in S3', async () => {
    const artifactName = 'test-artifact'
    const uploadUrl = 'https://s3.example.com/upload'
    const artifactId = 123

    mockS3ArtifactManager.createArtifact.mockResolvedValue({
      uploadUrl,
      artifactId
    })

    const result = await mockS3ArtifactManager.createArtifact(artifactName)
    expect(result.uploadUrl).toBe(uploadUrl)
    expect(result.artifactId).toBe(artifactId)
  })

  it('handles network errors', async () => {
    const artifactName = 'test-artifact'
    mockS3ArtifactManager.createArtifact.mockRejectedValue(
      new NetworkError('Connection failed')
    )

    await expect(
      mockS3ArtifactManager.createArtifact(artifactName)
    ).rejects.toThrow(NetworkError)
  })

  it('retries failed requests', async () => {
    const artifactName = 'test-artifact'
    const uploadUrl = 'https://s3.example.com/upload'
    const artifactId = 123

    mockS3ArtifactManager.createArtifact
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce({
        uploadUrl,
        artifactId
      })

    const result = await mockS3ArtifactManager.createArtifact(artifactName)
    expect(result.uploadUrl).toBe(uploadUrl)
    expect(result.artifactId).toBe(artifactId)
    expect(mockS3ArtifactManager.createArtifact).toHaveBeenCalledTimes(2)
  })

  it('handles non-retryable errors', async () => {
    const artifactName = 'test-artifact'
    const errorMessage = 'Access denied'

    mockS3ArtifactManager.createArtifact.mockRejectedValue(
      new Error(errorMessage)
    )

    await expect(
      mockS3ArtifactManager.createArtifact(artifactName)
    ).rejects.toThrow(errorMessage)
    expect(mockS3ArtifactManager.createArtifact).toHaveBeenCalledTimes(1)
  })

  it('handles invalid responses', async () => {
    const artifactName = 'test-artifact'
    mockS3ArtifactManager.createArtifact.mockResolvedValue({
      uploadUrl: '',
      artifactId: 0
    })

    const result = await mockS3ArtifactManager.createArtifact(artifactName)
    expect(result.uploadUrl).toBe('')
    expect(result.artifactId).toBe(0)
  })
})
