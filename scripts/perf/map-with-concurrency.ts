export async function mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    let firstFailure: Error | undefined;
    let failed = false;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (true) {
            if (failed) {
                return;
            }
            const index = nextIndex;
            nextIndex += 1;
            if (index >= values.length) {
                return;
            }
            try {
                results[index] = await mapper(values[index]!, index);
            }
            catch (error) {
                if (!failed) {
                    failed = true;
                    firstFailure = error instanceof Error ? error : new Error(String(error));
                }
                return;
            }
        }
    });
    await Promise.all(workers);
    if (firstFailure) {
        throw firstFailure;
    }
    return results;
}
