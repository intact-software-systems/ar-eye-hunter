// deno-lint-ignore-file no-explicit-any
import type {
    RallarRemoteBrowserControlFetch,
    RallarRemoteBrowserControlResultEnvelope
} from '../rallar-remote-browser-provider.ts';

export function remoteBrowserOptions(context: any): any {
    return context.options?.rallarRemoteBrowser ??
        context.options?.remoteBrowser ??
        {};
}

export function remoteBrowserFetch(context: any): RallarRemoteBrowserControlFetch {
    return remoteBrowserOptions(context).fetch ?? fetch;
}

export function isRallarRemoteBrowserRequest(request: any): boolean {
    const control = request?.control ?? {};
    return request?.provider === 'rallar-remote-browser' ||
        request?.remoteProvider === 'rallar-remote-browser' ||
        request?.remoteBrowser === true ||
        request?.browser === 'rallar-remote-browser' ||
        control.provider === 'rallar-remote-browser' ||
        control.mode === 'remote-browser' ||
        control.remoteBrowser === true;
}

export function remoteResultValue(result: RallarRemoteBrowserControlResultEnvelope): any {
    return result.result?.value ?? result.error?.details ?? result.error ?? result.result ?? result;
}

function toStringList(value: any): string[] {
    if (Array.isArray(value)) {
        return value
            .filter((item) => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim());
    }

    if (typeof value === 'string' && value.trim().length > 0) {
        return value
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }

    return [];
}

function remoteBrowserAllowedOrigins(request: any, context: any): string[] {
    const control = request?.control ?? {};
    const options = remoteBrowserOptions(context);
    return [
        ...toStringList(request.allowedOrigins),
        ...toStringList(request.remoteAllowedOrigins),
        ...toStringList(control.allowedOrigins),
        ...toStringList(options.allowedOrigins)
    ];
}

function remoteBrowserAllowedHosts(request: any, context: any): string[] {
    const control = request?.control ?? {};
    const options = remoteBrowserOptions(context);
    return [
        ...toStringList(request.allowedHosts),
        ...toStringList(request.remoteAllowedHosts),
        ...toStringList(control.allowedHosts),
        ...toStringList(options.allowedHosts)
    ];
}

function hostMatchesAllowedHost(host: string, hostname: string, allowedHost: string): boolean {
    if (allowedHost === host || allowedHost === hostname) {
        return true;
    }

    if (!allowedHost.startsWith('*.')) {
        return false;
    }

    const suffix = allowedHost.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

export interface AssertRemoteDestinationAllowedInput {
    readonly request: any;
    readonly context: any;
    readonly url: string | undefined;
    readonly label: string;
}

export function assertRemoteDestinationAllowed(input: AssertRemoteDestinationAllowedInput): void {
    const { request, context, url, label } = input;
    const allowedOrigins = remoteBrowserAllowedOrigins(request, context);
    const allowedHosts = remoteBrowserAllowedHosts(request, context);
    if (allowedOrigins.length <= 0 && allowedHosts.length <= 0) {
        return;
    }

    if (!url) {
        return;
    }

    let parsed: URL;
    try {
        parsed = new URL(url);
    }
    catch (_ignored) {
        return;
    }

    if (allowedOrigins.includes(parsed.origin)) {
        return;
    }

    if (allowedHosts.some((allowedHost) => hostMatchesAllowedHost(parsed.host, parsed.hostname, allowedHost))) {
        return;
    }

    throw new Error(`${label} destination is not allowed for remote browser execution: ${parsed.origin}`);
}

function remoteBrowserMaxPayloadBytes(request: any, context: any): number {
    const control = request?.control ?? {};
    const options = remoteBrowserOptions(context);
    const value = request.maxRemotePayloadBytes ??
        request.maxPayloadBytes ??
        control.maxPayloadBytes ??
        options.maxRemotePayloadBytes ??
        options.maxPayloadBytes ??
        1_000_000;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000_000;
}

function payloadByteLength(value: any): number {
    if (value === undefined || value === null) {
        return 0;
    }

    const text = typeof value === 'string'
        ? value
        : JSON.stringify(value) ?? '';
    return new TextEncoder().encode(text).length;
}

export interface AssertRemotePayloadWithinLimitInput {
    readonly request: any;
    readonly context: any;
    readonly value: any;
    readonly label: string;
}

export function assertRemotePayloadWithinLimit(input: AssertRemotePayloadWithinLimitInput): void {
    const { request, context, value, label } = input;
    const maxBytes = remoteBrowserMaxPayloadBytes(request, context);
    const byteLength = payloadByteLength(value);
    if (byteLength > maxBytes) {
        throw new Error(
            `${label} payload is too large for remote browser execution: ${byteLength} bytes exceeds ${maxBytes} bytes`
        );
    }
}

export function toRemoteHttpBody(request: any): any {
    if (request.form) {
        return new URLSearchParams(request.form).toString();
    }

    return request.body !== undefined &&
            request.method !== undefined &&
            String(request.method).toUpperCase() !== 'GET'
        ? request.body
        : undefined;
}

export function toRemoteHttpHeaders(request: any): Readonly<Record<string, string>> | undefined {
    if (!request.form) {
        return request.headers;
    }

    return {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...request.headers
    };
}

export function toRemoteHttpResponseOptions(request: any): any {
    const responseBody = request.remoteResponseBody ??
        request.responseBodyMode ??
        request.responseBody ??
        request.bodyMode ??
        'text';
    const maxBodyChars = request.maxBodyChars ?? request.responseMaxBodyChars;

    return maxBodyChars === undefined
        ? {
            body: responseBody
        }
        : {
            body: responseBody,
            maxBodyChars
        };
}
