import fs from 'fs'
import * as path from 'path'
import {downloadArtifact} from '../src/internal/download/download-artifact'
import {S3ArtifactManager} from '../src/internal/s3/artifact-manager'
import * as util from '../src/internal/shared/util'
import {DownloadArtifactResponse} from '../src/internal/shared/interfaces'

jest.mock('../src/internal/s3/artifact-manager')

const testDir = path.join(__dirname, '_temp', 'download-artifact')
const fixtures = {
  workspaceDir: path.join(testDir, 'workspace'),
  exampleArtifact: {
    path: path.join(testDir, 'artifact.zip'),
    files: [
      {
        path: 'hello.txt',
        content: 'Hello World!'
      },
      {
        path: 'goodbye.txt',
        content: 'Goodbye World!'
      }
    ]
  },
  artifactID: 1234,
  artifactName: 'my-artifact',
  artifactSize: 123456
}

describe('download-artifact', () => {
  let mockS3ArtifactManager: jest.Mocked<S3ArtifactManager>

  beforeEach(async () => {
    jest.clearAllMocks()
    mockS3ArtifactManager = {
      getSignedDownloadUrl: jest.fn().mockImplementation(async (artifactId: string) => {
        if (artifactId === fixtures.artifactID.toString()) {
          return 'https://s3.example.com/download'
        }
        throw new Error('Artifact not found')
      }),
      getArtifact: jest.fn().mockImplementation(async (name: string) => {
        if (name === fixtures.artifactName) {
          return {
            id: fixtures.artifactID,
            name: fixtures.artifactName,
            size: fixtures.artifactSize,
            createdAt: new Date()
          }
        }
        throw new Error('Artifact not found')
      }),
      listArtifacts: jest.fn().mockResolvedValue([]),
      createArtifact: jest.fn().mockResolvedValue({
        uploadUrl: 'https://example.com',
        artifactId: fixtures.artifactID
      }),
      deleteArtifact: jest.fn().mockResolvedValue({id: fixtures.artifactID}),
      uploadArtifact: jest.fn().mockResolvedValue({
        uploadSize: fixtures.artifactSize,
        sha256Hash: 'hash'
      }),
      finalizeArtifact: jest.fn().mockResolvedValue(undefined)
    } as unknown as jest.Mocked<S3ArtifactManager>
    jest.spyOn(util, 'getArtifactManager').mockReturnValue(mockS3ArtifactManager)
    await fs.promises.mkdir(testDir, {recursive: true})
  })

  afterEach(async () => {
    try {
      await fs.promises.rm(testDir, {recursive: true})
    } catch (error) {
      console.error(`Failed to clean up test directory: ${error}`)
    }
  })

  it('downloads artifact from S3', async () => {
    const downloadPath = path.join(fixtures.workspaceDir, 'download')
    const signedUrl = 'https://s3.example.com/download'

    mockS3ArtifactManager.getSignedDownloadUrl.mockResolvedValue(signedUrl)
    mockS3ArtifactManager.getArtifact.mockResolvedValue({
      id: fixtures.artifactID,
      name: fixtures.artifactName,
      size: fixtures.artifactSize
    })

    const result = await downloadArtifact(fixtures.artifactID)
    expect(result.downloadPath).toBeDefined()
    expect(mockS3ArtifactManager.getSignedDownloadUrl).toHaveBeenCalledWith(
      fixtures.artifactID.toString()
    )
  })

  it('throws error when download fails', async () => {
    const errorMessage = 'Failed to download artifact'
    mockS3ArtifactManager.getSignedDownloadUrl.mockRejectedValue(new Error(errorMessage))

    await expect(downloadArtifact(fixtures.artifactID)).rejects.toThrow(errorMessage)
  })

  it('downloads to custom path', async () => {
    const customPath = path.join(testDir, 'custom')
    const signedUrl = 'https://s3.example.com/download'

    mockS3ArtifactManager.getSignedDownloadUrl.mockResolvedValue(signedUrl)
    mockS3ArtifactManager.getArtifact.mockResolvedValue({
      id: fixtures.artifactID,
      name: fixtures.artifactName,
      size: fixtures.artifactSize
    })

    const result = await downloadArtifact(fixtures.artifactID, {path: customPath})
    expect(result.downloadPath).toBe(customPath)
  })

  it('creates download directory if it does not exist', async () => {
    const customPath = path.join(testDir, 'nonexistent')
    const signedUrl = 'https://s3.example.com/download'

    mockS3ArtifactManager.getSignedDownloadUrl.mockResolvedValue(signedUrl)
    mockS3ArtifactManager.getArtifact.mockResolvedValue({
      id: fixtures.artifactID,
      name: fixtures.artifactName,
      size: fixtures.artifactSize
    })

    const result = await downloadArtifact(fixtures.artifactID, {path: customPath})
    expect(result.downloadPath).toBe(customPath)
    expect(fs.existsSync(customPath)).toBe(true)
  })

  it('handles network errors during download', async () => {
    const signedUrl = 'https://s3.example.com/download'
    mockS3ArtifactManager.getSignedDownloadUrl.mockResolvedValue(signedUrl)
    mockS3ArtifactManager.getArtifact.mockRejectedValue(new Error('Network error'))

    await expect(downloadArtifact(fixtures.artifactID)).rejects.toThrow('Network error')
  })


  it('retries failed downloads', async () => {
    const signedUrl = 'https://s3.example.com/download'
    mockS3ArtifactManager.getSignedDownloadUrl.mockResolvedValue(signedUrl)
    mockS3ArtifactManager.getArtifact
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce({
        id: fixtures.artifactID,
        name: fixtures.artifactName,
        size: fixtures.artifactSize
      })

    const result = await downloadArtifact(fixtures.artifactID)
    expect(result.downloadPath).toBeDefined()
    expect(mockS3ArtifactManager.getArtifact).toHaveBeenCalledTimes(2)
  })
})
