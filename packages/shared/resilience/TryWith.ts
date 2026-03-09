function backoffDelayMs(
    attempt: number,
    base: number,
    max: number = 20_000,
    jitter: number = 0.2
): number {

    const raw = Math.min(max, base * Math.pow(2, Math.max(0, attempt - 1)));
    const j = raw * Math.max(0, Math.min(1, jitter));
    const delta = (Math.random() * 2 - 1) * j;

    return Math.max(0, Math.round(raw + delta));
}

export function tryWith<T>(
    handler: () => T,
    retryIntervalMsecs: number = 500,
    maxAttempts: number = Number.MAX_VALUE
) {
    return new Promise((resolve, reject) => {
        const tryToExecute =
            (
                currentRetryIntervalMsecs: number,
                attempts: number
            ) => {
                try {
                    resolve(handler())
                } catch (_) {
                    if (attempts >= maxAttempts) {
                        reject({error: 'Unable to do it'})
                    }

                    setTimeout(
                        () =>
                            tryToExecute(
                                backoffDelayMs(attempts, currentRetryIntervalMsecs),
                                attempts + 1
                            ),
                        currentRetryIntervalMsecs
                    )
                }
            }

        tryToExecute(retryIntervalMsecs, 1)
    })
}

export function tryRunInIntervals<T>(
    handler: () => T,
    intervalMsecs: number = 60000,
    retryIntervalMsecs: number = 10000,
    maxAttempts: number = Number.MAX_VALUE
) {
    return new Promise((resolve, reject) => {
        const tryToExecute =
            (
                currentRetryIntervalMsecs: number,
                attempts: number
            ) => {
                try {
                    resolve(handler())

                    setTimeout(
                        () =>
                            tryToExecute(
                                retryIntervalMsecs,
                                attempts + 1
                            ),
                        intervalMsecs
                    )

                } catch (_) {
                    if (attempts >= maxAttempts) {
                        reject({error: 'Unable to do it'})
                    }

                    setTimeout(
                        () =>
                            tryToExecute(
                                backoffDelayMs(attempts, currentRetryIntervalMsecs),
                                attempts + 1
                            ),
                        currentRetryIntervalMsecs
                    )
                }
            }

        tryToExecute(retryIntervalMsecs, 1)
    })
}