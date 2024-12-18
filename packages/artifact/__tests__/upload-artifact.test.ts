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
import { Readable, PassThrough } from 'stream'

jest.mock('@aws-sdk/client-s3')
jest.mock('@aws-sdk/lib-storage')

const uploadMock = jest.fn()
const s3ClientMock = {
  send: jest.fn(),
  config: {
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret'
    },
    endpoint: 'https://s3.amazonaws.com',
    endpointProvider: () => ({ url: 'https://s3.amazonaws.com' })
  },
  clone: jest.fn().mockImplementation(() => ({
    pipe: jest.fn().mockReturnThis(),
    clone: jest.fn()
  }))
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
  beforeAll(() => {
    // Create test directory structure
    fs.mkdirSync(fixtures.uploadDirectory, { recursive: true })
    fs.mkdirSync(path.join(fixtures.uploadDirectory, 'dir'), { recursive: true })

    // Create test files
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
            Bucket: command.input.Bucket
          })
        }
      })

    const result = await uploadArtifact(
      fixtures.inputs.artifactName,
      fixtures.inputs.files,
      fixtures.inputs.rootDirectory
    )

    expect(result.size).toBeGreaterThan(0)
    expect(s3ClientMock.send).toHaveBeenCalled()

    // Verify S3 upload commands
    const createMultipartCalls = s3ClientMock.send.mock.calls.filter(
      call => call[0].__type === 'CreateMultipartUploadCommand'
    )
    expect(createMultipartCalls.length).toBe(1)

    const uploadPartCalls = s3ClientMock.send.mock.calls.filter(
      call => call[0].__type === 'UploadPartCommand'
    )
    expect(uploadPartCalls.length).toBeGreaterThan(0)

    const completeUploadCalls = s3ClientMock.send.mock.calls.filter(
      call => call[0].__type === 'CompleteMultipartUploadCommand'
    )
    expect(completeUploadCalls.length).toBe(1)
  })
})
