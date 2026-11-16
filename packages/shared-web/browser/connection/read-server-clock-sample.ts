import { Either } from '@shared/resilience/Either.ts';
import type { RemoteClockObservation } from '@shared/resilience/remote-clock.ts';
import { toError } from '@shared/resilience/to-error.ts';

export interface ReadServerClockSampleInput {
    readonly baseUrl: string;
    readonly expectedServerPeerId: string;
    readonly signal: AbortSignal | undefined;
}

export interface ServerClockSampleDependencies {
    readonly fetch: typeof globalThis.fetch;
    readonly nowMonotonicMs: () => number;
}

export interface ServerClockReadFailure {
    readonly code: 'http' | 'invalid-response' | 'aborted' | 'network';
    readonly cause: Error;
}

export async function readServerClockSample(
    input: ReadServerClockSampleInput,
    dependencies: ServerClockSampleDependencies
): Promise<Either<ServerClockReadFailure, RemoteClockObservation>> {
    const requestStartedAtMonotonicMs = dependencies.nowMonotonicMs();
    try {
        input.signal?.throwIfAborted();
        const response = await dependencies.fetch(`${input.baseUrl}/api/time`, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal: input.signal
        });
        if (!response.ok) {
            return Either.ofLeft({
                code: 'http',
                cause: new Error(`Server clock request returned HTTP ${response.status}.`)
            });
        }
        const value: unknown = await response.json();
        input.signal?.throwIfAborted();
        if (
            value === null || typeof value !== 'object' ||
            !('serverPeerId' in value) || value.serverPeerId !== input.expectedServerPeerId ||
            !('serverNowEpochMs' in value) || typeof value.serverNowEpochMs !== 'number' ||
            !Number.isSafeInteger(value.serverNowEpochMs) || value.serverNowEpochMs < 0
        ) {
            return Either.ofLeft({
                code: 'invalid-response',
                cause: new Error('Server clock response has an invalid time or server identity.')
            });
        }
        return Either.ofRight({
            remoteEpochMs: value.serverNowEpochMs,
            requestStartedAtMonotonicMs,
            responseReceivedAtMonotonicMs: dependencies.nowMonotonicMs()
        });
    }
    catch (error) {
        const code = input.signal?.aborted ? 'aborted' : error instanceof SyntaxError ? 'invalid-response' : 'network';
        return Either.ofLeft({ code, cause: toError(error) });
    }
}
