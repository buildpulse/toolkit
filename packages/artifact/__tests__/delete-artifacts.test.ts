import {deleteArtifact} from '../src/internal/delete/delete-artifact'
import {S3ArtifactManager} from '../src/internal/s3/artifact-manager'
import * as util from '../src/internal/shared/util'
import {DeleteArtifactResponse} from '../src/internal/shared/interfaces'

jest.mock('../src/internal/s3/artifact-manager')
jest.mock('../src/internal/shared/util')

const fixtures = {
  artifactName: 'test-artifact',
  artifactId: '12345'
}

describe('delete-artifact', () => {
  let mockS3ArtifactManager: jest.Mocked<S3ArtifactManager>

  beforeEach(() => {
    jest.clearAllMocks()
    mockS3ArtifactManager = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://s3.example.com/download'),
      getArtifact: jest.fn().mockResolvedValue({
        id: parseInt(fixtures.artifactId),
        name: fixtures.artifactName,
        size: 100,
        createdAt: new Date()
      }),
      listArtifacts: jest.fn().mockResolvedValue([]),
      createArtifact: jest.fn().mockResolvedValue({
        uploadUrl: 'https://example.com',
        artifactId: parseInt(fixtures.artifactId)
      }),
      deleteArtifact: jest.fn().mockResolvedValue({
        id: parseInt(fixtures.artifactId)
      }),
      uploadArtifact: jest.fn().mockResolvedValue({
        uploadSize: 100,
        sha256Hash: 'hash'
      }),
      finalizeArtifact: jest.fn().mockResolvedValue(undefined)
    } as unknown as jest.Mocked<S3ArtifactManager>
    jest.spyOn(util, 'getArtifactManager').mockReturnValue(mockS3ArtifactManager)
  })

  it('deletes artifact from S3', async () => {
    const result = await deleteArtifact(fixtures.artifactId)
    expect(result.id).toBe(parseInt(fixtures.artifactId))
    expect(mockS3ArtifactManager.deleteArtifact).toHaveBeenCalledWith(
      expect.stringContaining(fixtures.artifactId)
    )
  })

  it('throws error when artifact deletion fails', async () => {
    const errorMessage = 'Failed to delete artifact'
    mockS3ArtifactManager.deleteArtifact.mockRejectedValue(new Error(errorMessage))

    await expect(deleteArtifact(fixtures.artifactId)).rejects.toThrow(errorMessage)
  })

  it('retries failed deletions', async () => {
    mockS3ArtifactManager.deleteArtifact
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce({
        id: parseInt(fixtures.artifactId)
      })

    const result = await deleteArtifact(fixtures.artifactId)
    expect(result.id).toBe(parseInt(fixtures.artifactId))
    expect(mockS3ArtifactManager.deleteArtifact).toHaveBeenCalledTimes(2)
  })
})
