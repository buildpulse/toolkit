import * as path from 'path'
import * as fs from 'fs'
import {NetworkError} from '../src/internal/shared/errors'
import {downloadArtifact} from '../src/internal/download/download-artifact'
import {IS3ArtifactManager} from '../src/internal/s3/types'

const fixtures = {
  artifactID: 12345,
  downloadUrl: 'https://test-bucket.s3.amazonaws.com/artifacts/test-artifact.zip',
  artifact: {
    id: '12345',
    name: 'test-artifact',
    size: 1024,
    created_at: new Date().toISOString()
  }
}

const mockS3ArtifactManager: jest.Mocked<IS3ArtifactManager> = {
  getArtifact: jest.fn().mockResolvedValue(fixtures.artifact),
  getSignedDownloadUrl: jest.fn().mockResolvedValue(fixtures.downloadUrl),
  uploadArtifact: jest.fn().mockResolvedValue({
    uploadSize: 1024,
    sha256Hash: 'mock-hash',
    uploadId: 'mock-upload-id'
  }),
  deleteArtifact: jest.fn().mockResolvedValue({id: fixtures.artifactID, success: true}),
  listArtifacts: jest.fn().mockResolvedValue([fixtures.artifact]),
  createArtifact: jest.fn().mockResolvedValue({
    uploadUrl: 'mock-upload-url',
    artifactId: fixtures.artifactID
  }),
  finalizeArtifact: jest.fn().mockResolvedValue(undefined),
  clone: jest.fn()
}

// Set up clone to return a new mock instance instead of self-reference
mockS3ArtifactManager.clone.mockResolvedValue({...mockS3ArtifactManager})

jest.mock('../src/internal/shared/util', () => ({
  getArtifactManager: () => mockS3ArtifactManager
}))

describe('downloadArtifact', () => {
  const testDir = path.join(__dirname, 'test-downloads')

  beforeEach(async () => {
    jest.clearAllMocks()
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {})
    await fs.promises.mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true })
  })

  it('downloads artifact successfully', async () => {
    const result = await downloadArtifact(fixtures.artifactID)
    expect(result.downloadPath).toBeDefined()
    expect(result.artifact).toBeDefined()
    expect(mockS3ArtifactManager.getSignedDownloadUrl).toHaveBeenCalledWith(fixtures.artifactID.toString())
  }, 30000)

  it('downloads to custom path', async () => {
    const customPath = path.join(testDir, 'custom')
    const result = await downloadArtifact(fixtures.artifactID, {path: customPath})
    expect(result.downloadPath).toBe(customPath)
    expect(result.artifact).toBeDefined()
  }, 30000)

  it('creates download directory if it does not exist', async () => {
    const newDir = path.join(testDir, 'new-dir')
    const result = await downloadArtifact(fixtures.artifactID, {path: newDir})
    expect(result.downloadPath).toBe(newDir)
    const dirExists = await fs.promises.access(newDir).then(() => true).catch(() => false)
    expect(dirExists).toBe(true)
  }, 30000)

  it('handles network errors during download', async () => {
    mockS3ArtifactManager.getSignedDownloadUrl
      .mockRejectedValueOnce(new NetworkError('NetworkingError', 'Unknown network error occurred'))

    await expect(downloadArtifact(fixtures.artifactID)).rejects.toThrow(NetworkError)
  }, 30000)

  it('handles artifact not found', async () => {
    mockS3ArtifactManager.getArtifact.mockRejectedValueOnce(
      new Error('Artifact not found')
    )

    await expect(downloadArtifact(fixtures.artifactID)).rejects.toThrow(
      'No artifacts found for ID'
    )
  }, 30000)

  it('retries failed downloads', async () => {
    mockS3ArtifactManager.getSignedDownloadUrl
      .mockRejectedValueOnce(new NetworkError('NetworkingError', 'Temporary failure'))
      .mockResolvedValueOnce(fixtures.downloadUrl)

    const result = await downloadArtifact(fixtures.artifactID)
    expect(result.downloadPath).toBeDefined()
    expect(result.artifact).toBeDefined()
    expect(mockS3ArtifactManager.getSignedDownloadUrl).toHaveBeenCalledTimes(2)
  }, 30000)
})
