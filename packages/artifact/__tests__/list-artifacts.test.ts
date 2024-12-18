import {listArtifacts} from '../src/internal/find/list-artifacts'
import * as util from '../src/internal/shared/util'
import {S3ArtifactManager} from '../src/internal/s3/artifact-manager'
import {Artifact} from '../src/internal/shared/interfaces'

jest.mock('../src/internal/s3/artifact-manager')
jest.mock('../src/internal/shared/util')

const fixtures = {
  artifacts: [
    {
      id: 1,
      name: 'my-artifact',
      size: 456,
      createdAt: new Date('2023-12-01')
    },
    {
      id: 2,
      name: 'my-artifact',
      size: 456,
      createdAt: new Date('2023-12-02')
    }
  ] as Artifact[]
}

describe('list-artifacts', () => {
  let mockS3ArtifactManager: jest.Mocked<S3ArtifactManager>

  beforeEach(() => {
    jest.clearAllMocks()
    mockS3ArtifactManager = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://s3.example.com/download'),
      getArtifact: jest.fn().mockResolvedValue(fixtures.artifacts[0]),
      listArtifacts: jest.fn().mockResolvedValue(fixtures.artifacts),
      createArtifact: jest.fn().mockResolvedValue({
        uploadUrl: 'https://example.com',
        artifactId: 1
      }),
      deleteArtifact: jest.fn().mockResolvedValue({id: 1}),
      uploadArtifact: jest.fn().mockResolvedValue({
        uploadSize: 100,
        sha256Hash: 'hash'
      }),
      finalizeArtifact: jest.fn().mockResolvedValue(undefined)
    } as unknown as jest.Mocked<S3ArtifactManager>
    jest.spyOn(util, 'getArtifactManager').mockReturnValue(mockS3ArtifactManager)
  })

  it('returns a list of artifacts', async () => {
    const response = await listArtifacts()
    expect(response).toEqual({
      artifacts: fixtures.artifacts
    })
  })

  it('returns empty array when no artifacts exist', async () => {
    mockS3ArtifactManager.listArtifacts.mockResolvedValue([])

    const response = await listArtifacts()
    expect(response).toEqual({
      artifacts: []
    })
  })

  it('throws error on list failure', async () => {
    mockS3ArtifactManager.listArtifacts.mockRejectedValue(new Error('Failed to list artifacts'))

    await expect(listArtifacts()).rejects.toThrow('Failed to list artifacts')
  })
})
