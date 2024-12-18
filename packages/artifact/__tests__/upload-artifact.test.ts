import * as uploadZipSpecification from '../src/internal/upload/upload-zip-specification'
import * as zip from '../src/internal/upload/zip'
import * as util from '../src/internal/shared/util'
import * as config from '../src/internal/shared/config'
import {ArtifactServiceClientJSON} from '../src/generated'
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

const uploadMock = jest.fn()
const s3ClientMock = {
  send: jest.fn()
}

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
  uploadDirectory: path.join(__dirname, '_temp', 'plz-upload'),
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
  backendIDs: {
    workflowRunBackendId: '67dbcc20-e851-4452-a7c3-2cc0d2e0ec67',
    workflowJobRunBackendId: '5f49179d-3386-4c38-85f7-00f8138facd0'
  },
  runtimeToken: 'test-token',
  resultsServiceURL: 'http://results.local',
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
    fs.mkdirSync(fixtures.uploadDirectory, {
      recursive: true
    })

    for (const file of fixtures.files) {
      if (file.symlink) {
        let symlinkPath = file.symlink
        if (!file.relative) {
          symlinkPath = path.join(fixtures.uploadDirectory, file.symlink)
        }

        if (!fs.existsSync(path.join(fixtures.uploadDirectory, file.name))) {
          fs.symlinkSync(
            symlinkPath,
            path.join(fixtures.uploadDirectory, file.name),
            'file'
          )
        }
      } else {
        fs.writeFileSync(
          path.join(fixtures.uploadDirectory, file.name),
          file.content
        )
      }
    }
  })

  beforeEach(() => {
    noopLogs()
    jest
      .spyOn(uploadZipSpecification, 'validateRootDirectory')
      .mockReturnValue()
    jest
      .spyOn(util, 'getBackendIdsFromToken')
      .mockReturnValue(fixtures.backendIDs)
    jest
      .spyOn(uploadZipSpecification, 'getUploadZipSpecification')
      .mockReturnValue(
        fixtures.files.map(file => ({
          sourcePath: path.join(fixtures.uploadDirectory, file.name),
          destinationPath: file.name,
          stats: fs.statSync(path.join(fixtures.uploadDirectory, file.name))
        }))
      )
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('should reject if there are no files to upload', async () => {
    jest
      .spyOn(uploadZipSpecification, 'getUploadZipSpecification')
      .mockClear()
      .mockReturnValue([])

    const uploadResp = uploadArtifact(
      fixtures.inputs.artifactName,
      fixtures.inputs.files,
      fixtures.inputs.rootDirectory
    )
    await expect(uploadResp).rejects.toThrowError(FilesNotFoundError)
  })

  it('should reject if no backend IDs are found', async () => {
    jest.spyOn(util, 'getBackendIdsFromToken').mockRestore()

    const uploadResp = uploadArtifact(
      fixtures.inputs.artifactName,
      fixtures.inputs.files,
      fixtures.inputs.rootDirectory
    )

    await expect(uploadResp).rejects.toThrow()
  })

  it('should return false if the creation request fails', async () => {
    jest
      .spyOn(zip, 'createZipUploadStream')
      .mockReturnValue(Promise.resolve(new zip.ZipUploadStream(1)))
    jest
      .spyOn(ArtifactServiceClientJSON.prototype, 'CreateArtifact')
      .mockReturnValue(Promise.resolve({ok: false, signedUploadUrl: ''}))

    const uploadResp = uploadArtifact(
      fixtures.inputs.artifactName,
      fixtures.inputs.files,
      fixtures.inputs.rootDirectory
    )

    await expect(uploadResp).rejects.toThrow()
  })

  it('should return false if S3 upload is unsuccessful', async () => {
    jest
      .spyOn(zip, 'createZipUploadStream')
      .mockReturnValue(Promise.resolve(new zip.ZipUploadStream(1)))
    jest
      .spyOn(ArtifactServiceClientJSON.prototype, 'CreateArtifact')
      .mockReturnValue(
        Promise.resolve({
          ok: true,
          signedUploadUrl: 'https://signed-upload-url.com'
        })
      )
    jest
      .spyOn(s3Upload, 'uploadZipToS3')
      .mockReturnValue(Promise.reject(new Error('S3 upload failed')))

    const uploadResp = uploadArtifact(
      fixtures.inputs.artifactName,
      fixtures.inputs.files,
      fixtures.inputs.rootDirectory
    )

    await expect(uploadResp).rejects.toThrow()
  })

  it('should reject if finalize artifact fails', async () => {
    jest
      .spyOn(zip, 'createZipUploadStream')
      .mockReturnValue(Promise.resolve(new zip.ZipUploadStream(1)))
    jest
      .spyOn(ArtifactServiceClientJSON.prototype, 'CreateArtifact')
      .mockReturnValue(
        Promise.resolve({
          ok: true,
          signedUploadUrl: 'https://signed-upload-url.com'
        })
      )
    jest.spyOn(s3Upload, 'uploadZipToS3').mockReturnValue(
      Promise.resolve({
        uploadSize: 1234,
        sha256Hash: 'test-sha256-hash'
      })
    )
    jest
      .spyOn(ArtifactServiceClientJSON.prototype, 'FinalizeArtifact')
      .mockReturnValue(Promise.resolve({ok: false, artifactId: ''}))

    const uploadResp = uploadArtifact(
      fixtures.inputs.artifactName,
      fixtures.inputs.files,
      fixtures.inputs.rootDirectory
    )

    await expect(uploadResp).rejects.toThrow()
  })

  it('should successfully upload an artifact', async () => {
    jest
      .spyOn(uploadZipSpecification, 'getUploadZipSpecification')
      .mockRestore()

    jest
      .spyOn(ArtifactServiceClientJSON.prototype, 'CreateArtifact')
      .mockReturnValue(
        Promise.resolve({
          ok: true,
          signedUploadUrl: 'https://test-bucket.s3.amazonaws.com/test.zip'
        })
      )
    jest
      .spyOn(ArtifactServiceClientJSON.prototype, 'FinalizeArtifact')
      .mockReturnValue(
        Promise.resolve({
          ok: true,
          artifactId: '1'
        })
      )

    let loadedBytes = 0
    const uploadedZip = path.join(
      fixtures.uploadDirectory,
      '..',
      'uploaded.zip'
    )
    if (fs.existsSync(uploadedZip)) {
      fs.unlinkSync(uploadedZip)
    }

    // Mock S3 multipart upload responses
    s3ClientMock.send.mockImplementation(command => {
      if (command.__type === 'CreateMultipartUploadCommand') {
        return Promise.resolve({ UploadId: 'test-upload-id' })
      }
      if (command.__type === 'UploadPartCommand') {
        const inputBody = command.input.Body
        if (Buffer.isBuffer(inputBody)) {
          const stream = createReadableStream(inputBody)
          const writeStream = fs.createWriteStream(uploadedZip, { flags: 'a' })

          return new Promise((resolve, reject) => {
            stream.on('data', chunk => {
              loadedBytes += chunk.length
              writeStream.write(chunk)
            })
            stream.on('end', () => {
              writeStream.end()
              resolve({ ETag: `"part-${command.input.PartNumber}"` })
            })
            stream.on('error', reject)
          })
        }
        return Promise.reject(new Error('Invalid stream'))
      }
      if (command.__type === 'CompleteMultipartUploadCommand') {
        return Promise.resolve({
          Location: 'https://test-bucket.s3.amazonaws.com/test.zip',
          ETag: '"final-etag"'
        })
      }
      return Promise.reject(new Error('Unknown command'))
    })

    const {id, size} = await uploadArtifact(
      fixtures.inputs.artifactName,
      fixtures.files.map(file => path.join(fixtures.uploadDirectory, file.name)),
      fixtures.uploadDirectory
    )

    expect(id).toBe(1)
    expect(size).toBe(loadedBytes)

    const extractedDirectory = path.join(
      fixtures.uploadDirectory,
      '..',
      'extracted'
    )
    if (fs.existsSync(extractedDirectory)) {
      fs.rmdirSync(extractedDirectory, {recursive: true})
    }

    const extract = new Promise((resolve, reject) => {
      fs.createReadStream(uploadedZip)
        .pipe(unzip.Extract({path: extractedDirectory}))
        .on('close', () => {
          resolve(true)
        })
        .on('error', err => {
          reject(err)
        })
    })

    await expect(extract).resolves.toBe(true)
    for (const file of fixtures.files) {
      const filePath = path.join(extractedDirectory, file.name)
      expect(fs.existsSync(filePath)).toBe(true)
      expect(fs.readFileSync(filePath, 'utf8')).toBe(file.content)
    }
  })

  it('should throw an error uploading blob chunks get delayed', async () => {
    jest
      .spyOn(ArtifactServiceClientJSON.prototype, 'CreateArtifact')
      .mockReturnValue(
        Promise.resolve({
          ok: true,
          signedUploadUrl: 'https://test-bucket.s3.amazonaws.com/test.zip'
        })
      )

    // Mock S3 multipart upload with delay
    s3ClientMock.send.mockImplementation(command => {
      if (command.__type === 'CreateMultipartUploadCommand') {
        return Promise.resolve({ UploadId: 'test-upload-id' })
      }
      if (command.__type === 'UploadPartCommand') {
        const inputBody = command.input.Body
        if (Buffer.isBuffer(inputBody)) {
          const stream = createReadableStream(inputBody)

          return new Promise((resolve) => {
            // Delay the upload to simulate stalled progress
            setTimeout(() => {
              resolve({ ETag: `"part-${command.input.PartNumber}"` })
            }, 31000) // Longer than the stall timeout
          })
        }
        return Promise.reject(new Error('Invalid stream'))
      }
      if (command.__type === 'CompleteMultipartUploadCommand') {
        return Promise.resolve({
          Location: 'https://test-bucket.s3.amazonaws.com/test.zip',
          ETag: '"final-etag"'
        })
      }
      return Promise.reject(new Error('Unknown command'))
    })

  })
})
// PLACEHOLDER: remaining test cases and cleanup
