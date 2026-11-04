import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Command } from '@shared/cache/Command.ts';
import { TryWithExhaustedError, TryWithPolicy } from '@shared/resilience/try-with-policy.ts';
import { ApiHttpError } from './http-error.ts';
import { sendApiHttpRequest } from './send-api-http-request.ts';

export interface ReadApiViewInput {
    readonly baseUrl: string;
    readonly path: string;
    readonly session: AuthSession;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
}

/** A lost invalidation read gets bounded transport recovery; domain decoding stays with its view owner. */
export async function readApiView(input: ReadApiViewInput): Promise<ApiJsonValue> {
    try {
        return await new Command(async (signal) => {
            return await TryWithPolicy.defaults().label('canonical view read')
                .maxAttempts(3).retryIntervalMsecs(250).maxRetryIntervalMsecs(1000)
                .retryIf((error) =>
                    !signal?.aborted && (
                        error instanceof ApiHttpError
                            ? error.status === 408 || error.status === 429 || error.status >= 500
                            : error instanceof TypeError
                    )
                )
                .run(async () => {
                    signal?.throwIfAborted();
                    return await sendApiHttpRequest<never, ApiJsonValue>({
                        baseUrl: input.baseUrl,
                        path: input.path,
                        method: 'GET',
                        body: undefined,
                        options: { authSession: input.session, signal }
                    });
                });
        }, { signal: input.signal, timeoutMs: input.timeoutMs, maxAttempts: 1, errorOnNull: false }).run();
    }
    catch (error) {
        // Preserve definitive authority errors even when the last bounded attempt receives one.
        throw error instanceof TryWithExhaustedError ? error.cause : error;
    }
}
