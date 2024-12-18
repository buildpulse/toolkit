import * as uploadZipSpecification from '../src/internal/upload/upload-zip-specification'
import * as zip from '../src/internal/upload/zip'
import * as util from '../src/internal/shared/util'
import * as config from '../src/internal/shared/config'
import * as s3Upload from '../src/internal/upload/s3-upload'
import {uploadArtifact} from '../src/internal/upload/upload-artifact'
import {noopLogs} from './common'
import {FilesNotFoundError} from '../src/internal/shared/errors'
import * as fs from 'fs'
import * as path from 'path'
import unzip from 'unzip-stream'
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand
} from '@aws-sdk/client-s3'
import {S3ArtifactManager} from '../src/internal/s3/artifact-manager'
import {Readable, PassThrough} from 'stream'

jest.mock('@aws-sdk/client-s3')
jest.mock('@aws-sdk/lib-storage')

const uploadMock = jest.fn()
const s3ClientMock = {
  send: jest.fn().mockImplementation(async command => {
    if (command.constructor.name === 'CreateMultipartUploadCommand') {
      return {UploadId: 'test-upload-id'}
    }
    if (command.constructor.name === 'HeadObjectCommand') {
      return {
        ContentLength: 1234,
        ETag: '"test-etag"'
      }
    }
    if (command.constructor.name === 'UploadPartCommand') {
      return {
        ETag: '"test-etag"'
      }
    }
    if (command.constructor.name === 'CompleteMultipartUploadCommand') {
      return {
        Location: 'https://s3.example.com/test-artifact',
        ETag: '"test-etag"'
      }
    }
    return {}
  }),
  config: {
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret'
    },
    endpoint: 'https://s3.amazonaws.com',
    endpointProvider: () => ({ url: 'https://s3.amazonaws.com' })
  },
  clone: function() {
    return {
      ...this,
      config: {...this.config},
      send: this.send
    }
  }
} as any

// Helper function to create a readable stream from a buffer
const createReadableStream = (buffer: Buffer): Readable => {
  const readable = new PassThrough()
  readable.end(buffer)
  return readable
}

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => s3ClientMock),
  CreateMultipartUploadCommand: jest.fn().mockImplementation(input => ({
    input,
    __type: 'CreateMultipartUploadCommand'
  })),
  UploadPartCommand: jest.fn().mockImplementation(input => ({
    input,
    __type: 'UploadPartCommand'
  })),
  CompleteMultipartUploadCommand: jest.fn().mockImplementation(input => ({
    input,
    __type: 'CompleteMultipartUploadCommand'
  }))
}))

const fixtures = {
  uploadDirectory: '/home/user/files/plz-upload',
  files: [
    {name: 'file1.txt', content: 'test 1 file content'},
    {name: 'file2.txt', content: 'test 2 file content'},
    {name: 'file3.txt', content: 'test 3 file content'},
    {
      name: 'real.txt',
      content: 'from a symlink'
    },
    {
      name: 'relative.txt',
      content: 'from a symlink',
      symlink: 'real.txt',
      relative: true
    },
    {
      name: 'absolute.txt',
      content: 'from a symlink',
      symlink: 'real.txt',
      relative: false
    }
  ],
  inputs: {
    artifactName: 'test-artifact',
    files: [
      '/home/user/files/plz-upload/file1.txt',
      '/home/user/files/plz-upload/file2.txt',
      '/home/user/files/plz-upload/dir/file3.txt'
    ],
    rootDirectory: '/home/user/files/plz-upload'
  }
}

describe('upload-artifact', () => {
  let mockS3ArtifactManager: jest.Mocked<S3ArtifactManager>

  beforeAll(() => {
    // Create test directory structure
    fs.mkdirSync(fixtures.uploadDirectory, { recursive: true })
    fs.mkdirSync(path.join(fixtures.uploadDirectory, 'dir'), { recursive: true })

    // Create test files
    fs.writeFileSync(path.join(fixtures.uploadDirectory, 'file1.txt'), 'test 1 file content')
    fs.writeFileSync(path.join(fixtures.uploadDirectory, 'file2.txt'), 'test 2 file content')
    fs.writeFileSync(path.join(fixtures.uploadDirectory, 'dir', 'file3.txt'), 'test 3 file content')

    for (const file of fixtures.files) {
      const filePath = path.join(fixtures.uploadDirectory, file.name)
      if (file.symlink) {
        const targetPath = path.join(fixtures.uploadDirectory, file.symlink)
        fs.writeFileSync(targetPath, file.content)
        try {
          fs.unlinkSync(filePath)
        } catch (error) {
          // Ignore error if file doesn't exist
        }
        fs.symlinkSync(
          file.relative ? path.basename(targetPath) : targetPath,
          filePath
        )
      } else {
        fs.writeFileSync(filePath, file.content)
      }
    }
  })

  beforeEach(() => {
    jest.clearAllMocks()
    s3ClientMock.send.mockReset()

    // Set required environment variables for tests
    process.env.AWS_ARTIFACT_BUCKET = 'test-bucket'
    process.env.AWS_REGION = 'us-east-1'
    process.env.AWS_ACCESS_KEY_ID = 'test-key'
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret'

    const config = {
      region: 'us-east-1',
      bucket: 'test-bucket',
      credentials: {
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret'
      }
    }
    mockS3ArtifactManager = {
      createArtifact: jest.fn().mockResolvedValue({
        uploadUrl: 'https://s3.example.com/upload',
        artifactId: 12345
      }),
      uploadArtifact: jest.fn().mockImplementation(async (key: string, stream: Readable) => ({
        uploadSize: 1024,
        sha256Hash: 'test-hash',
        uploadId: 'test-upload-id'
      })),
      finalizeArtifact: jest.fn().mockImplementation(async (key: string, uploadId: string) => undefined),
      clone: jest.fn().mockImplementation(async () => mockS3ArtifactManager),
      getSignedDownloadUrl: jest.fn().mockImplementation(async (key: string) => 'https://s3.example.com/download'),
      listArtifacts: jest.fn().mockResolvedValue([]),
      getArtifact: jest.fn().mockImplementation(async (name: string) => ({
        id: 12345,
        name: 'test-artifact',
        size: 1024,
        createdAt: new Date()
      })),
      deleteArtifact: jest.fn().mockImplementation(async (artifactId: string) => ({
        success: true,
        id: parseInt(artifactId, 10)
      }))
    } as unknown as jest.Mocked<S3ArtifactManager>

    jest.spyOn(util, 'getArtifactManager').mockReturnValue(mockS3ArtifactManager)
  })

  afterEach(() => {
    // Clean up environment variables
    delete process.env.AWS_ARTIFACT_BUCKET
    delete process.env.AWS_REGION
    delete process.env.AWS_ACCESS_KEY_ID
    delete process.env.AWS_SECRET_ACCESS_KEY
  })

  afterAll(() => {
    try {
      fs.rmSync(fixtures.uploadDirectory, { recursive: true, force: true })
    } catch (err) {
      console.error('Error cleaning up test directory:', err)
    }
  })

  it('should throw if no files are found', async () => {
    await expect(
      uploadArtifact(
        'my-artifact',
        ['non-existent-file'],
        '/non-existent-dir'
      )
    ).rejects.toThrow(FilesNotFoundError)
  })

  it('should upload files to S3', async () => {
    // Mock S3 client responses
    s3ClientMock.send
      .mockImplementationOnce((command) => {
        if (command.__type === 'CreateMultipartUploadCommand') {
          return Promise.resolve({
            UploadId: 'test-upload-id',
            Key: command.input.Key,
            Bucket: command.input.Bucket
          })
        }
        return Promise.resolve({})
      })
      .mockImplementation((command) => {
        if (command.__type === 'UploadPartCommand') {
          return Promise.resolve({
            ETag: `"etag-${command.input.PartNumber}"`
          })
        }
        if (command.__type === 'CompleteMultipartUploadCommand') {
          return Promise.resolve({
            Location: `https://${command.input.Bucket}.s3.amazonaws.com/${command.input.Key}`,
            Key: command.input.Key,
            Bucket: command.input.Bucket,
            ETag: '"final-etag"'
          })
        }
        return Promise.resolve({})
      })

    // Mock artifact manager methods
    mockS3ArtifactManager.createArtifact.mockResolvedValueOnce({
      uploadUrl: 'https://s3.example.com/upload',
      artifactId: 12345
    })

    mockS3ArtifactManager.clone.mockResolvedValueOnce(mockS3ArtifactManager)

    const result = await uploadArtifact(
      fixtures.inputs.artifactName,
      fixtures.inputs.files,
      fixtures.inputs.rootDirectory
    )

    // Verify the result
    expect(result).toBeDefined()
    expect(result.id).toBe(12345)
    expect(result.size).toBeGreaterThan(0)

    // Verify S3 interactions
    expect(mockS3ArtifactManager.createArtifact).toHaveBeenCalledTimes(1)
    expect(mockS3ArtifactManager.clone).toHaveBeenCalledTimes(1)
    expect(s3ClientMock.send).toHaveBeenCalled()
  })
})
