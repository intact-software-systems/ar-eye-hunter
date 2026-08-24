import {
    BrowserTransportRuntime,
    type ApiMiddleware
} from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { MiddlewareInitOptions } from '@shared-web/browser/middleware.ts';

export type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';

const browserTransportRuntime = new BrowserTransportRuntime();

export function getMiddleware(): ApiMiddleware {
    return browserTransportRuntime.requireMiddleware();
}

export function isMiddlewareReady(): boolean {
    return browserTransportRuntime.isReady();
}

export async function initMiddleware(
    options: MiddlewareInitOptions = {}
): Promise<ApiMiddleware> {
    return await browserTransportRuntime.init(options);
}

export function clearMiddleware(): void {
    browserTransportRuntime.shutdown();
}
