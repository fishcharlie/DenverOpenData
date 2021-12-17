export interface AsyncThrottleConfiguration {
	concurrency: number;
}
/**
 * AsyncThrottle is a utility class that can be used to throttle the number of concurrent calls to a function.
 * @param array - The array to iterate over
 * @param func - Function that returns a Promise to call on each element of the array
 * @param config - {concurrentCalls: number}
 * @returns An array of results from your promises. Note, it might not be in the same order as the input.
 */
export default async function <T, M>(array: T[], func: (item: T) => Promise<M>, config: AsyncThrottleConfiguration): Promise<M[]> {
	const results: M[] = [];

	const queue: T[] = [...array];

	async function runner(number: number): Promise<void> {
		let isRunning = true;
		do {
			const item = queue.shift();
			if (item) {
				const result = await func(item);
				results.push(result);
			} else {
				isRunning = false;
			}
		} while (isRunning)
	}
	await Promise.all(new Array(config.concurrency).fill(0).map((_, i) => runner(i)));

	return results;
}
