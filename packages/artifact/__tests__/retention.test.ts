import {getRetentionDays} from '../src/internal/upload/retention'

describe('retention', () => {
  beforeEach(() => {
    delete process.env['INPUT_RETENTION-DAYS']
  })

  it('returns undefined when no retention days specified', () => {
    const retention = getRetentionDays()
    expect(retention).toBeUndefined()
  })

  it('returns number when valid retention days specified', () => {
    process.env['INPUT_RETENTION-DAYS'] = '5'
    const retention = getRetentionDays()
    expect(retention).toBe(5)
    delete process.env['INPUT_RETENTION-DAYS']
  })

  it('throws error for invalid retention days', () => {
    process.env['INPUT_RETENTION-DAYS'] = 'invalid'
    expect(() => getRetentionDays()).toThrow()
    delete process.env['INPUT_RETENTION-DAYS']
  })

  it('throws error for negative retention days', () => {
    process.env['INPUT_RETENTION-DAYS'] = '-5'
    expect(() => getRetentionDays()).toThrow()
    delete process.env['INPUT_RETENTION-DAYS']
  })
})
