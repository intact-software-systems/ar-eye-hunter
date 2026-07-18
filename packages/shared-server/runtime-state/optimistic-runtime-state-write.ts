import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
} from './RuntimeStateRepository.ts';

export const DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS = 3;
export const DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS = [0, 2, 8] as const;

export class RuntimeStateWriteConflictError extends Error {
    constructor() {
        super('Runtime state conditional write conflict');
        this.name = 'RuntimeStateWriteConflictError';
    }
}

export class RuntimeStateRetryExhaustedError extends Error {
    readonly status = 503;
    readonly code = 'runtime-state-write-conflict';
    readonly attempts = DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS;

    constructor(cause: RuntimeStateWriteConflictError) {
        super(
            `Runtime state write conflicted during ${DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS} attempts`,
            { cause },
        );
        this.name = 'RuntimeStateRetryExhaustedError';
    }
}

type RuntimeStateConditionalResult =
    | RuntimeStateConditionalWriteResult
    | RuntimeStateConditionalDeleteResult;

export function requireConditionalWrite<Result extends RuntimeStateConditionalResult>(
    result: Result,
): Extract<Result, Readonly<{ status: 'applied' }>> {
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }

    return result as Extract<Result, Readonly<{ status: 'applied' }>>;
}

export async function waitForRuntimeStateWriteRetry(
    attempt: 0 | 1 | 2,
    options: Readonly<{
        sleep?: (delayMs: number) => Promise<void>;
    }> = {},
): Promise<number> {
    const delayMs = DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS[attempt];
    if (delayMs === undefined) {
        throw new RangeError(`Invalid runtime state write attempt: ${attempt}`);
    }

    if (delayMs > 0) {
        await (options.sleep ?? sleep)(delayMs);
    }
    return delayMs;
}

function sleep(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}
