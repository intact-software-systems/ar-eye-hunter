import { computeHttpIdleTimeoutSeconds } from '@shared-server/http/compute-http-idle-timeout-seconds.ts';
import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';

export interface ApiBunServeHandlers<TFetch, TWebSocket extends object> {
    readonly fetch: TFetch;
    readonly websocket: TWebSocket;
}

export interface ApiBunServeOptions<TFetch, TWebSocket extends object> {
    readonly hostname: string;
    readonly port: number;
    readonly idleTimeout: number;
    readonly fetch: TFetch;
    readonly websocket: TWebSocket & { readonly closeOnBackpressureLimit: true; };
}

/**
 * Past its backpressure limit Bun drops a frame while the socket stays open, so later frames would arrive after a
 * silent hole. Closing the socket instead turns the overflow into a disconnect the client observes and reconnects
 * from; the dropped frame itself is already a failed send for the delivery accounting.
 */
export function toApiBunServeOptions<TFetch, TWebSocket extends object>(
    configuration: Pick<ApiV1Configuration, 'http' | 'appInbox'>,
    handlers: ApiBunServeHandlers<TFetch, TWebSocket>
): ApiBunServeOptions<TFetch, TWebSocket> {
    return {
        hostname: configuration.http.hostname,
        port: configuration.http.port,
        idleTimeout: computeHttpIdleTimeoutSeconds(configuration.appInbox.completionWait.maxElapsedMs),
        fetch: handlers.fetch,
        websocket: { ...handlers.websocket, closeOnBackpressureLimit: true }
    };
}
