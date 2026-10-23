/** Keep sibling snapshot work within the command lifetime, even when one fails. */
export async function settledSnapshots<T>(snapshots: readonly [Promise<T>, Promise<T>]): Promise<[T, T]> {
  let failure: { reason: unknown } | undefined;
  const results = await Promise.allSettled(snapshots.map((snapshot) => snapshot.catch((reason: unknown) => {
    failure ??= { reason };
    throw reason;
  })));
  if (failure !== undefined) throw failure.reason;
  // Both snapshots fulfilled; retain the snapshot order for callers.
  return results.map((result) => (result as PromiseFulfilledResult<T>).value) as [T, T];
}
