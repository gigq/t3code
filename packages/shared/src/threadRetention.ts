export const SNAPSHOT_MAX_THREAD_MESSAGES = 2_000;
export const SNAPSHOT_MAX_THREAD_CHECKPOINTS = 500;
export const SNAPSHOT_MAX_THREAD_PROPOSED_PLANS = 200;
export const SNAPSHOT_MAX_THREAD_ACTIVITIES = 500;

export function retainMostRecentItems<T>(items: ReadonlyArray<T>, limit: number): ReadonlyArray<T> {
  if (items.length <= limit) {
    return items;
  }
  return items.slice(-limit);
}
