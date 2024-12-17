import * as uploadUtils from '../src/internal/uploadUtils'
import {Progress} from '@aws-sdk/lib-storage'

test('upload progress tracked correctly', () => {
  const progress = new uploadUtils.UploadProgress(1000)

  expect(progress.contentLength).toBe(1000)
  expect(progress.sentBytes).toBe(0)
  expect(progress.displayedComplete).toBe(false)
  expect(progress.timeoutHandle).toBeUndefined()
  expect(progress.getTransferredBytes()).toBe(0)
  expect(progress.isDone()).toBe(false)

  progress.onProgress()({loaded: 0} as Progress)

  expect(progress.contentLength).toBe(1000)
  expect(progress.sentBytes).toBe(0)
  expect(progress.displayedComplete).toBe(false)
  expect(progress.timeoutHandle).toBeUndefined()
  expect(progress.getTransferredBytes()).toBe(0)
  expect(progress.isDone()).toBe(false)

  progress.onProgress()({loaded: 250} as Progress)

  expect(progress.contentLength).toBe(1000)
  expect(progress.sentBytes).toBe(250)
  expect(progress.displayedComplete).toBe(false)
  expect(progress.timeoutHandle).toBeUndefined()
  expect(progress.getTransferredBytes()).toBe(250)
  expect(progress.isDone()).toBe(false)

  progress.onProgress()({loaded: 500} as Progress)

  expect(progress.contentLength).toBe(1000)
  expect(progress.sentBytes).toBe(500)
  expect(progress.displayedComplete).toBe(false)
  expect(progress.timeoutHandle).toBeUndefined()
  expect(progress.getTransferredBytes()).toBe(500)
  expect(progress.isDone()).toBe(false)

  progress.onProgress()({loaded: 750} as Progress)

  expect(progress.contentLength).toBe(1000)
  expect(progress.sentBytes).toBe(750)
  expect(progress.displayedComplete).toBe(false)
  expect(progress.timeoutHandle).toBeUndefined()
  expect(progress.getTransferredBytes()).toBe(750)
  expect(progress.isDone()).toBe(false)

  progress.onProgress()({loaded: 1000} as Progress)

  expect(progress.contentLength).toBe(1000)
  expect(progress.sentBytes).toBe(1000)
  expect(progress.displayedComplete).toBe(false)
  expect(progress.timeoutHandle).toBeUndefined()
  expect(progress.getTransferredBytes()).toBe(1000)
  expect(progress.isDone()).toBe(true)
})
