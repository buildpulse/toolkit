/**
 * Returns the number of days to retain the artifact.
 * Returns undefined if no retention days are specified.
 * Throws an error if the retention days is not a valid number between 1 and 90.
 */
export function getRetentionDays(): number | undefined {
  const retentionDays = process.env['INPUT_RETENTION-DAYS']
  if (!retentionDays) {
    return undefined
  }

  const retentionDaysInt = parseInt(retentionDays)
  if (
    Number.isNaN(retentionDaysInt) ||
    retentionDaysInt < 1 ||
    retentionDaysInt > 90
  ) {
    throw new Error('Retention days must be a number between 1 and 90')
  }

  return retentionDaysInt
}
