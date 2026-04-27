// Per-key serialization for read-modify-write sections.
//
// withLock(key, fn) runs fn() after any prior withLock(key, ...) for the same
// key has settled, so critical sections against a shared resource (e.g. a
// single index file) don't interleave. Keys are independent — different keys
// run in parallel. Single-process only; does not coordinate across workers.

const chains = new Map<string, Promise<unknown>>();

export async function withLock<T>(
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const prev = chains.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	chains.set(
		key,
		next.finally(() => {
			if (chains.get(key) === next) chains.delete(key);
		}),
	);
	return next;
}
