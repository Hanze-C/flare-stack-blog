/** Server UTC calendar date (YYYY-MM-DD). */
export function serverUtcDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * True when the publish date is later than `now`, to the second: a time later
 * today is in the future too. The column stores whole seconds.
 */
export function isFuturePublishDate(publishedAt: Date, now = new Date()) {
  return publishedAt.getTime() > now.getTime();
}

/**
 * The publish date the editor stores for a day picked in its date picker
 * (YYYY-MM-DD, UTC). A past day is stored at noon UTC, as before. Today is
 * stored at its start, since noon may still be ahead and publishing would then
 * refuse it as a date in the future.
 */
export function pickedPublishDate(day: string, serverToday: string) {
  return new Date(`${day}T${day < serverToday ? "12:00:00" : "00:00:00"}Z`);
}

/**
 * `date` cut to the whole second, the precision `posts.published_at` stores,
 * so the Public Content Snapshot carries the same value admin reads return.
 */
export function toWholeSecond(date: Date) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}
