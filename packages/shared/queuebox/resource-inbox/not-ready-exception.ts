/** Translation at an exception-based handler boundary; QueueBox keeps readiness outside the attempt budget. */
export class NotReadyException extends Error {
    readonly delayMs: number;

    constructor(delayMs: number, message = 'Work is not ready') {
        super(message);
        this.name = 'NotReadyException';
        this.delayMs = delayMs;
    }
}

export function isNotReadyException(exception: Error): exception is NotReadyException {
    return exception instanceof NotReadyException && Number.isSafeInteger(exception.delayMs) && exception.delayMs > 0;
}
