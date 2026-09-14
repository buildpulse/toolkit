import type {AwsCredentialIdentityProvider} from '@aws-sdk/types'

/**
 * Credential resolution for the cache's S3 backend.
 *
 * The rule this file exists to enforce: the cache resolves its credentials from
 * sources that are explicitly the cache's own, and never from the ambient
 * `AWS_*` environment. Two failures made that rule necessary.
 *
 * 1. `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` were read straight out of the
 *    environment as the cache's credentials. A job that configures AWS for its
 *    own purposes therefore had its own credentials used against the cache
 *    bucket, where they have no access. Worse, a runner that supplies
 *    credentials any other way -- a shared credentials file, or the credential
 *    endpoint a container platform injects -- set neither variable, so the cache
 *    concluded it was not configured at all and skipped itself entirely.
 *
 *    Not reading those two variables is not sufficient on its own. The SDK's
 *    default provider chain reads them first too, ahead of both the shared
 *    credentials file and any credentials the platform supplies, so handing the
 *    SDK a config with no `credentials` and letting it work things out
 *    reintroduces the same hijack one layer down. Every branch below therefore
 *    builds a specific provider, and `defaultProvider()` is never used.
 *
 * 2. A credentials file located by expanding `$HOME` is lost by any job that
 *    changes `HOME` -- a container step, a tool that resets it. `fromIni` is
 *    given an absolute `filepath` here, so `HOME` takes no part in finding it.
 *
 * Resolution order, most specific first. The first source that is configured
 * wins outright; a configured source that then fails to authenticate is an
 * error, never a reason to try the next one. Silently falling through is how a
 * misconfiguration turns into a cache that is merely slow instead of broken.
 */
export const enum CredentialSource {
  Explicit = 'caller-supplied keys',
  ExplicitFile = 'caller-supplied credentials file',
  EnvFile = 'BP_CACHE_AWS_CREDENTIALS_FILE',
  EnvKeys = 'BP_CACHE_AWS_ACCESS_KEY_ID',
  ContainerRole = 'container credentials',
  None = 'none'
}

/**
 * Credentials passed in by the caller. This library has no action inputs of its
 * own, so the two most specific sources are only reachable when the action
 * embedding it forwards its own inputs. They are kept here so that the
 * resolution order is the same one the standalone action implements, rather
 * than a second, subtly different order that has to be reasoned about twice.
 */
export interface CredentialOverrides {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  credentialsFile?: string
  profile?: string
  region?: string
}

export interface ResolvedCredentials {
  source: CredentialSource
  /**
   * Undefined means "there is no configured source", never "let the SDK work it
   * out". A caller that gets `CredentialSource.None` must treat the cache as
   * unconfigured rather than trying anyway.
   */
  credentials?: AwsCredentialIdentityProvider
  /** Human-readable detail for the log line. Never contains secret material. */
  detail?: string
}

function env(name: string): string {
  return (process.env[name] || '').trim()
}

function given(value: string | undefined): string {
  return (value || '').trim()
}

/**
 * The container-credential variables that task-role and pod-identity agents
 * inject. Reading them is not the ambient-credentials problem: they are set by
 * the platform into the container, and they cannot be pointed at a different
 * principal without also moving the endpoint they name.
 */
function hasContainerCredentials(): boolean {
  return !!(
    env('AWS_CONTAINER_CREDENTIALS_FULL_URI') ||
    env('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI')
  )
}

export function resolveCredentials(
  overrides: CredentialOverrides = {}
): ResolvedCredentials {
  const explicitKeyId = given(overrides.accessKeyId)
  const explicitSecret = given(overrides.secretAccessKey)
  if (explicitKeyId && explicitSecret) {
    const sessionToken = given(overrides.sessionToken) || undefined
    return {
      source: CredentialSource.Explicit,
      credentials: async () => ({
        accessKeyId: explicitKeyId,
        secretAccessKey: explicitSecret,
        // Carried deliberately. Dropping it is what made temporary credentials
        // unusable: they sign, and S3 rejects the signature with an error that
        // names the access key, which reads as an entirely different problem.
        sessionToken
      })
    }
  }
  if (explicitKeyId || explicitSecret) {
    throw new Error(
      'accessKeyId and secretAccessKey must be supplied together for the cache bucket'
    )
  }

  const explicitFile = given(overrides.credentialsFile)
  if (explicitFile) {
    return fromIniSource(
      CredentialSource.ExplicitFile,
      explicitFile,
      given(overrides.profile) || undefined
    )
  }

  const envFile = env('BP_CACHE_AWS_CREDENTIALS_FILE')
  if (envFile) {
    return fromIniSource(
      CredentialSource.EnvFile,
      envFile,
      given(overrides.profile) || env('BP_CACHE_AWS_PROFILE') || undefined
    )
  }

  const envKeyId = env('BP_CACHE_AWS_ACCESS_KEY_ID')
  const envSecret = env('BP_CACHE_AWS_SECRET_ACCESS_KEY')
  if (envKeyId && envSecret) {
    return {
      source: CredentialSource.EnvKeys,
      credentials: async () => ({
        accessKeyId: envKeyId,
        secretAccessKey: envSecret,
        sessionToken: env('BP_CACHE_AWS_SESSION_TOKEN') || undefined
      })
    }
  }

  if (hasContainerCredentials()) {
    return {
      source: CredentialSource.ContainerRole,
      // Required lazily so a job that never reaches this branch does not pay
      // for loading the provider.
      credentials: async () => {
        if (env('AWS_CONTAINER_CREDENTIALS_FULL_URI')) {
          const {fromHttp} = await import('@aws-sdk/credential-provider-http')
          return fromHttp({})()
        }
        const {fromContainerMetadata} = await import(
          '@smithy/credential-provider-imds'
        )
        return fromContainerMetadata({})()
      }
    }
  }

  return {source: CredentialSource.None}
}

function fromIniSource(
  source: CredentialSource,
  filepath: string,
  profile?: string
): ResolvedCredentials {
  return {
    source,
    detail: profile ? `${filepath} (profile ${profile})` : filepath,
    credentials: async () => {
      const {fromIni} = await import('@aws-sdk/credential-provider-ini')
      // `filepath` is absolute and passed explicitly, so neither HOME nor
      // AWS_SHARED_CREDENTIALS_FILE takes part in locating it. `profile`
      // likewise beats AWS_PROFILE.
      return fromIni({filepath, profile, ignoreCache: true})()
    }
  }
}

/**
 * The region the cache bucket lives in. Distinct from the caller's own
 * `AWS_REGION`, which is read only as a fallback for setups predating
 * `BP_CACHE_AWS_REGION`; when that is what gets used, say so, because a region
 * pointing at the wrong endpoint produces a signature error that looks like a
 * credentials problem.
 */
export function resolveRegion(overrides: CredentialOverrides = {}): {
  region: string
  fromAmbient: boolean
} {
  const explicit = given(overrides.region) || env('BP_CACHE_AWS_REGION')
  if (explicit) {
    return {region: explicit, fromAmbient: false}
  }
  return {region: env('AWS_REGION'), fromAmbient: true}
}

/** The bucket the cache reads and writes. */
export function resolveBucket(): string {
  return env('BP_CACHE_S3_BUCKET')
}
