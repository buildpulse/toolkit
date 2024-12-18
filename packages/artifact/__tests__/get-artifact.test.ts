import {getArtifact} from '../src/internal/find/get-artifact'
import {S3ArtifactManager} from '../src/internal/s3/artifact-manager'
import * as util from '../src/internal/shared/util'
import {noopLogs} from './common'
import {
  ArtifactNotFoundError,
  InvalidResponseError
} from '../src/internal/shared/errors'
import {Artifact} from '../src/internal/shared/interfaces'

jest.mock('../src/internal/s3/artifact-manager')
jest.mock('../src/internal/shared/util')

const fixtures = {
  artifactName: 'test-artifact',
  artifacts: [
    {
      id: 1,
      name: 'test-artifact',
      size: 456,
      createdAt: new Date('2023-12-01')
    },
    {
      id: 2,
      name: 'test-artifact',
      size: 789,
      createdAt: new Date('2023-12-02')
    }
  ] as Artifact[]
}

describe('get-artifact', () => {
  let mockS3ArtifactManager: jest.Mocked<S3ArtifactManager>

  beforeAll(() => {
    noopLogs()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockS3ArtifactManager = jest.mocked(new S3ArtifactManager({} as any))
    mockS3ArtifactManager.getArtifact.mockResolvedValue(fixtures.artifacts[0])
    mockS3ArtifactManager.listArtifacts.mockResolvedValue([fixtures.artifacts[0]])
    mockS3ArtifactManager.createArtifact.mockResolvedValue({
      uploadUrl: 'https://example.com',
      artifactId: 1
    })
    mockS3ArtifactManager.deleteArtifact.mockResolvedValue({id: 1})
    mockS3ArtifactManager.uploadArtifact.mockResolvedValue({
      uploadSize: 100,
      sha256Hash: 'hash'
    })
    mockS3ArtifactManager.finalizeArtifact.mockResolvedValue()
    mockS3ArtifactManager.getSignedDownloadUrl.mockResolvedValue('https://example.com')
    jest.spyOn(util, 'getArtifactManager').mockReturnValue(mockS3ArtifactManager)
  })

  it('should return the artifact if it is found', async () => {
    const response = await getArtifact(fixtures.artifactName)
    expect(response).toEqual({
      artifact: fixtures.artifacts[0]
    })
  })

  it('should fail if no artifacts are found', async () => {
    mockS3ArtifactManager.getArtifact.mockRejectedValue(
      new ArtifactNotFoundError('Not found')
    )

    await expect(getArtifact(fixtures.artifactName, {failIfNotFound: true})).rejects.toThrow(
      ArtifactNotFoundError
    )
  })

  it('should fail if S3 returns an error', async () => {
    const error = new Error('S3 error')
    mockS3ArtifactManager.getArtifact.mockRejectedValue(error)

    await expect(getArtifact(fixtures.artifactName)).rejects.toThrow(ArtifactNotFoundError)
  })

  it('should fail with InvalidResponseError for malformed responses', async () => {
    mockS3ArtifactManager.getArtifact.mockRejectedValue(
      new InvalidResponseError('Invalid response')
    )

    await expect(getArtifact(fixtures.artifactName)).rejects.toThrow(ArtifactNotFoundError)
  })
})
