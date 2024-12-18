import * as config from '../src/internal/shared/config'
import * as util from '../src/internal/shared/util'
import {S3ArtifactManager, S3Config} from '../src/internal/s3/artifact-manager'

describe('util', () => {
  beforeEach(() => {
    jest.resetAllMocks()
  })

  describe('getArtifactManager', () => {
    it('returns S3ArtifactManager instance with valid config', () => {
      const mockS3Config: S3Config = {
        region: 'us-east-1',
        bucket: 'test-bucket',
        credentials: {
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret'
        }
      }

      jest.spyOn(config, 'getS3Config').mockReturnValue(mockS3Config)

      const manager = util.getArtifactManager()
      expect(manager).toBeInstanceOf(S3ArtifactManager)
    })

    it('throws error when S3 config is missing', () => {
      jest.spyOn(config, 'getS3Config').mockImplementation(() => {
        throw new Error('S3 configuration is required')
      })

      expect(() => util.getArtifactManager()).toThrow('S3 configuration is required')
    })

    it('throws error when S3 bucket is missing', () => {
      const mockS3Config: S3Config = {
        region: 'us-east-1',
        credentials: {
          accessKeyId: 'test-key',
          secretAccessKey: 'test-secret'
        }
      } as S3Config

      jest.spyOn(config, 'getS3Config').mockReturnValue(mockS3Config)

      expect(() => util.getArtifactManager()).toThrow('S3 bucket is required')
    })
  })
})
