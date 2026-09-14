import * as cache from '../src/cache'
import {CacheFailure, classify} from '../src/internal/shared/cacheErrors'
import {
  CredentialSource,
  resolveCredentials,
  resolveRegion
} from '../src/internal/shared/credentials'

/**
 * These exist because the bug they cover is a RELATIONSHIP, not a unit: the
 * cache must end up using the credentials it was given, whatever else happens to
 * be in the job's environment, and it must report itself available on exactly
 * the runners where that succeeds. Testing the pieces separately is what let
 * several versions ship in which the ambient environment decided both.
 */

const KEEP = {...process.env}

function setEnv(vars: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('AWS_') || k.startsWith('BP_CACHE_')) {
      delete process.env[k]
    }
  }
  delete process.env['ACTIONS_CACHE_URL']
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) {
      process.env[k] = v
    }
  }
}

afterAll(() => {
  process.env = KEEP
})

/**
 * The job's own credentials, exactly as the usual AWS configure action exports
 * them. Present in every case below, and never the ones the cache should pick.
 */
const AMBIENT = {
  AWS_ACCESS_KEY_ID: 'ASIAAMBIENTKEY',
  AWS_SECRET_ACCESS_KEY: 'ambient-secret',
  AWS_SESSION_TOKEN: 'ambient-token',
  AWS_REGION: 'eu-central-1'
}

describe('credential resolution ignores the ambient AWS environment', () => {
  it('prefers a credentials file over the ambient keys', () => {
    setEnv({
      ...AMBIENT,
      BP_CACHE_AWS_CREDENTIALS_FILE: '/etc/cache/credentials',
      BP_CACHE_AWS_PROFILE: 'cache'
    })
    const r = resolveCredentials()
    expect(r.source).toBe(CredentialSource.EnvFile)
    expect(r.detail).toContain('/etc/cache/credentials')
    expect(r.detail).toContain('cache')
  })

  it('prefers the prefixed keys over the ambient keys', () => {
    setEnv({
      ...AMBIENT,
      BP_CACHE_AWS_ACCESS_KEY_ID: 'AKIACACHEKEY',
      BP_CACHE_AWS_SECRET_ACCESS_KEY: 'cache-secret'
    })
    expect(resolveCredentials().source).toBe(CredentialSource.EnvKeys)
  })

  it('prefers container credentials over the ambient keys', () => {
    setEnv({
      ...AMBIENT,
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials'
    })
    expect(resolveCredentials().source).toBe(CredentialSource.ContainerRole)
  })

  it('also honours the relative-URI form of container credentials', () => {
    setEnv({
      ...AMBIENT,
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc'
    })
    expect(resolveCredentials().source).toBe(CredentialSource.ContainerRole)
  })

  it('never falls back to the ambient keys when nothing else is set', () => {
    setEnv({...AMBIENT})
    expect(resolveCredentials().source).toBe(CredentialSource.None)
    expect(resolveCredentials().credentials).toBeUndefined()
  })

  it('lets caller-supplied keys win over everything', () => {
    setEnv({
      ...AMBIENT,
      BP_CACHE_AWS_CREDENTIALS_FILE: '/etc/cache/credentials'
    })
    expect(
      resolveCredentials({
        accessKeyId: 'AKIAEXPLICIT',
        secretAccessKey: 'explicit-secret'
      }).source
    ).toBe(CredentialSource.Explicit)
  })

  it('rejects a half-configured key pair rather than falling through', () => {
    setEnv({...AMBIENT})
    expect(() => resolveCredentials({accessKeyId: 'AKIAONLY'})).toThrow(
      /must be supplied together/
    )
  })

  it('carries a session token, which is what makes temporary credentials work', async () => {
    setEnv({
      BP_CACHE_AWS_ACCESS_KEY_ID: 'ASIACACHE',
      BP_CACHE_AWS_SECRET_ACCESS_KEY: 'cache-secret',
      BP_CACHE_AWS_SESSION_TOKEN: 'cache-token'
    })
    const resolved = resolveCredentials()
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const creds = await resolved.credentials!()
    expect(creds.sessionToken).toBe('cache-token')
  })
})

describe('region', () => {
  it("prefers the cache's own region over the job's", () => {
    setEnv({AWS_REGION: 'eu-central-1', BP_CACHE_AWS_REGION: 'us-west-2'})
    expect(resolveRegion()).toEqual({region: 'us-west-2', fromAmbient: false})
  })

  it('falls back to the ambient region and says so', () => {
    setEnv({AWS_REGION: 'eu-central-1'})
    expect(resolveRegion()).toEqual({region: 'eu-central-1', fromAmbient: true})
  })
})

describe('isFeatureAvailable reflects whether a cache is configured', () => {
  /**
   * The regression that motivated all of this: a runner supplying credentials
   * by file or by container endpoint sets neither ambient key variable, so the
   * old check said no cache was available and every consumer skipped caching
   * while reporting it as a cache service it could not reach.
   */
  it('is available when credentials come from a file', () => {
    setEnv({
      BP_CACHE_S3_BUCKET: 'cache-bucket',
      BP_CACHE_AWS_REGION: 'us-west-2',
      BP_CACHE_AWS_CREDENTIALS_FILE: '/etc/cache/credentials'
    })
    expect(cache.isFeatureAvailable()).toBe(true)
  })

  it('is available when credentials come from the container endpoint', () => {
    setEnv({
      BP_CACHE_S3_BUCKET: 'cache-bucket',
      AWS_REGION: 'us-west-2',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials'
    })
    expect(cache.isFeatureAvailable()).toBe(true)
  })

  it('is available with the prefixed keys', () => {
    setEnv({
      BP_CACHE_S3_BUCKET: 'cache-bucket',
      BP_CACHE_AWS_REGION: 'us-west-2',
      BP_CACHE_AWS_ACCESS_KEY_ID: 'AKIACACHEKEY',
      BP_CACHE_AWS_SECRET_ACCESS_KEY: 'cache-secret'
    })
    expect(cache.isFeatureAvailable()).toBe(true)
  })

  it('is NOT available on ambient keys alone, however complete they look', () => {
    setEnv({...AMBIENT, BP_CACHE_S3_BUCKET: 'cache-bucket'})
    expect(cache.isFeatureAvailable()).toBe(false)
  })

  it('is not available without a bucket', () => {
    setEnv({
      BP_CACHE_AWS_REGION: 'us-west-2',
      BP_CACHE_AWS_ACCESS_KEY_ID: 'AKIACACHEKEY',
      BP_CACHE_AWS_SECRET_ACCESS_KEY: 'cache-secret'
    })
    expect(cache.isFeatureAvailable()).toBe(false)
  })

  it('is not available without a region', () => {
    setEnv({
      BP_CACHE_S3_BUCKET: 'cache-bucket',
      BP_CACHE_AWS_ACCESS_KEY_ID: 'AKIACACHEKEY',
      BP_CACHE_AWS_SECRET_ACCESS_KEY: 'cache-secret'
    })
    expect(cache.isFeatureAvailable()).toBe(false)
  })

  it('is not available with a bucket and region but no credentials', () => {
    setEnv({
      BP_CACHE_S3_BUCKET: 'cache-bucket',
      BP_CACHE_AWS_REGION: 'us-west-2'
    })
    expect(cache.isFeatureAvailable()).toBe(false)
  })

  it('does not throw when credentials are half-configured, it reports false', () => {
    setEnv({
      BP_CACHE_S3_BUCKET: 'cache-bucket',
      BP_CACHE_AWS_REGION: 'us-west-2',
      BP_CACHE_AWS_ACCESS_KEY_ID: 'AKIAONLY'
    })
    expect(cache.isFeatureAvailable()).toBe(false)
  })

  it('still reports the original cache service as available', () => {
    setEnv({})
    process.env['ACTIONS_CACHE_URL'] = 'http://cache.com'
    expect(cache.isFeatureAvailable()).toBe(true)
    delete process.env['ACTIONS_CACHE_URL']
  })
})

describe('a denied cache is not a cache miss', () => {
  it.each([
    ['AccessDenied', CacheFailure.Auth],
    ['InvalidAccessKeyId', CacheFailure.Auth],
    ['ExpiredToken', CacheFailure.Auth],
    ['SignatureDoesNotMatch', CacheFailure.Auth],
    ['CredentialsProviderError', CacheFailure.Auth],
    ['NoSuchKey', CacheFailure.Miss],
    ['NotFound', CacheFailure.Miss],
    ['TimeoutError', CacheFailure.Other]
  ])('classifies %s', (name, expected) => {
    expect(classify(Object.assign(new Error('boom'), {name}))).toBe(expected)
  })

  it('classifies by HTTP status when the name is unhelpful', () => {
    expect(classify({name: 'Unknown', $metadata: {httpStatusCode: 403}})).toBe(
      CacheFailure.Auth
    )
    expect(classify({name: 'Unknown', $metadata: {httpStatusCode: 404}})).toBe(
      CacheFailure.Miss
    )
  })

  it('still recognises an error that was stringified into a plain Error', () => {
    expect(
      classify(new Error('Failed to download cache from S3: AccessDenied'))
    ).toBe(CacheFailure.Auth)
  })
})
