/**
 * Returns a Date object for when the artifact should expire based on the retention days.
 * Returns undefined if the retention days is undefined or not a valid number between 1 and 90.
 * @param retentionDays number of days to retain the artifact
 */
export function getExpiration(retentionDays?: number): Date | undefined {
  if (!retentionDays) {
    return undefined
  }

  const retentionDaysInt = parseInt(retentionDays.toString())
  if (
    Number.isNaN(retentionDaysInt) ||
    retentionDaysInt < 1 ||
    retentionDaysInt > 90
  ) {
    return undefined
  }

  const expirationDate = new Date()
  expirationDate.setDate(expirationDate.getDate() + retentionDaysInt)
  return expirationDate
}
