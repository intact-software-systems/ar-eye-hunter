import { readServerClockEpoch } from '@shared/api/api-config.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { RemoteClockObservation } from '@shared/resilience/remote-clock.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { SOCKET_CLOCK_REPLY_PREFIX, socketClockRequest } from '@shared/websocket/socket-clock.ts';
import type { ServerClockReadFailure } from './read-server-clock-sample.ts';

export interface ReadSocketClockSampleInput {
    readonly readSocket: () => Pick<WebSocket, 'readyState' | 'send' | 'addEventListener'> | undefined;
    readonly expectedServerPeerId: string;
    readonly nowMonotonicMs: () => number;
    readonly signal: AbortSignal;
}

/** Only the matching reply on the socket that sent the challenge can bound this round trip. */
export async function readSocketClockSample(
    input: ReadSocketClockSampleInput
): Promise<Either<ServerClockReadFailure, RemoteClockObservation>> {
    const listeners = new AbortController();
    try {
        input.signal.throwIfAborted();
        const socket = input.readSocket();
        if (socket?.readyState !== 1) {
            throw new Error('Clock sample requires an open socket.');
        }
        const nonce = crypto.randomUUID();
        const prefix = SOCKET_CLOCK_REPLY_PREFIX + nonce + ' ';
        const reply = Promise.withResolvers<number>();
        const options = { signal: listeners.signal };
        socket.addEventListener('message', (event) => {
            if (typeof event.data !== 'string' || !event.data.startsWith(prefix)) {
                return;
            }
            try {
                const value: ApiJsonValue = JSON.parse(event.data.slice(prefix.length));
                const epoch = readServerClockEpoch(value, input.expectedServerPeerId);
                if (epoch === undefined || input.readSocket() !== socket) {
                    throw new Error('Socket clock response has an invalid time, peer or connection.');
                }
                reply.resolve(epoch);
            }
            catch (error) {
                reply.reject(error);
            }
        }, options);
        socket.addEventListener('close', () => reply.reject(new Error('Clock socket closed.')), options);
        input.signal.addEventListener('abort', () => reply.reject(input.signal.reason), options);
        const requestStartedAtMonotonicMs = input.nowMonotonicMs();
        socket.send(socketClockRequest(nonce));
        const remoteEpochMs = await reply.promise;
        input.signal.throwIfAborted();
        if (input.readSocket() !== socket || socket.readyState !== 1) {
            throw new Error('Clock socket changed during the observation.');
        }
        return Either.ofRight({
            remoteEpochMs,
            requestStartedAtMonotonicMs,
            responseReceivedAtMonotonicMs: input.nowMonotonicMs()
        });
    }
    catch (error) {
        return Either.ofLeft({ code: input.signal.aborted ? 'aborted' : 'network', cause: toError(error) });
    }
    finally {
        listeners.abort();
    }
}
