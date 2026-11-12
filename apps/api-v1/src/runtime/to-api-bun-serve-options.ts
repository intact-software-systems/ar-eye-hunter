import type { ApiV1Configuration } from '../configuration/api-v1-configuration.ts';
import { computeApiHttpIdleTimeoutSeconds } from '../configuration/compute-api-http-idle-timeout-seconds.ts';

export interface ApiBunServeHandlers<TFetch, TWebSocket> {
    readonly fetch: TFetch;
    readonly websocket: TWebSocket;
}

export interface ApiBunServeOptions<TFetch, TWebSocket> extends ApiBunServeHandlers<TFetch, TWebSocket> {
    readonly port: number;
    readonly idleTimeout: number;
}

export function toApiBunServeOptions<TFetch, TWebSocket>(
    configuration: Pick<ApiV1Configuration, 'http' | 'appInbox'>,
    handlers: ApiBunServeHandlers<TFetch, TWebSocket>
): ApiBunServeOptions<TFetch, TWebSocket> {
    return {
        port: configuration.http.port,
        idleTimeout: computeApiHttpIdleTimeoutSeconds(configuration.appInbox.completionWait),
        fetch: handlers.fetch,
        websocket: handlers.websocket
    };
}
