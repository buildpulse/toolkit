import * as core from '@actions/core'

const DEFAULT_RETRY_DELAY_MS = 1000
const DEFAULT_MAX_RETRIES = 3

export interface RetryOptions {
  maxRetries?: number
  delayMs?: number
  retryableErrors?: string[]
}

/**
 * Retries a function with exponential backoff
 * @param fn The function to retry
 * @param options Retry options
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES
  const delayMs = options.delayMs || DEFAULT_RETRY_DELAY_MS
  const retryableErrors = options.retryableErrors || []

  let lastError: Error | undefined
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error
      const isRetryable =
        retryableErrors.length === 0 ||
        retryableErrors.some(msg =>
          lastError?.message?.includes(msg) ||
          (lastError as any)?.code === msg
        )

      if (!isRetryable || attempt === maxRetries) {
        throw error
      }

      const delay = delayMs * Math.pow(2, attempt - 1)
      core.debug(
        `Attempt ${attempt} failed, retrying in ${delay}ms: ${lastError.message}`
      )
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw lastError
}
