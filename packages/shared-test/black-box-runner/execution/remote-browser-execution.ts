// deno-lint-ignore-file no-explicit-any
import type { ControlResultEnvelope } from '../../rallar-bb-test/control-protocol.ts';
import type { BlackBoxFetch } from './black-box-scenario-context.ts';

export interface ValidateRemoteDestinationInput {
    readonly request: any;
    readonly context: any;
    /** Absent when the step names no destination, which leaves nothing to check. */
    readonly url: string | undefined;
    readonly label: string;
}

export interface ValidateRemotePayloadSizeInput {
    readonly request: any;
    readonly context: any;
    readonly value: any;
    readonly label: string;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1_000_000;

export function getRemoteBrowserRunnerOptions(context: any): any {
    return context.options?.rallarRemoteBrowser ?? {};
}

/** A fetch given in the runner's remote-browser options wins over the runner's own fetch dependency. */
export function resolveRemoteBrowserFetch(context: any): BlackBoxFetch {
    return getRemoteBrowserRunnerOptions(context).fetch ?? context.dependencies.fetch;
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

export function toRemoteResultValue(result: ControlResultEnvelope): any {
    return result.result?.value ?? result.error?.details ?? result.error ?? result.result ?? result;
}

/** An empty allowlist allows every destination; a destination that is not a URL is not checked. */
export function validateRemoteDestination(input: ValidateRemoteDestinationInput): readonly string[] {
    const { request, context, url, label } = input;
    const allowedOrigins = resolveAllowedDestinations(request, context, ['allowedOrigins', 'remoteAllowedOrigins']);
    const allowedHosts = resolveAllowedDestinations(request, context, ['allowedHosts', 'remoteAllowedHosts']);
    const destination = allowedOrigins.length > 0 || allowedHosts.length > 0 ? toDestinationUrl(url) : undefined;
    if (
        destination === undefined ||
        allowedOrigins.includes(destination.origin) ||
        allowedHosts.some((allowedHost) => isAllowedHost(destination, allowedHost))
    ) {
        return [];
    }
    return [`${label} destination is not allowed for remote browser execution: ${destination.origin}`];
}

export function validateRemotePayloadSize(input: ValidateRemotePayloadSizeInput): readonly string[] {
    const { request, context, value, label } = input;
    const maxBytes = resolveMaxPayloadBytes(request, context);
    const byteLength = computePayloadByteLength(value);
    return byteLength > maxBytes
        ? [`${label} payload is too large for remote browser execution: ${byteLength} bytes exceeds ${maxBytes} bytes`]
        : [];
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

function resolveAllowedDestinations(request: any, context: any, keys: readonly [string, string]): string[] {
    const [key, remoteKey] = keys;
    return [
        ...toStringList(request[key]),
        ...toStringList(request[remoteKey]),
        ...toStringList(request?.control?.[key]),
        ...toStringList(getRemoteBrowserRunnerOptions(context)[key])
    ];
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

function toDestinationUrl(url: string | undefined): URL | undefined {
    if (!url) {
        return undefined;
    }
    try {
        return new URL(url);
    }
    catch {
        return undefined;
    }
}

function isAllowedHost(destination: URL, allowedHost: string): boolean {
    if (allowedHost === destination.host || allowedHost === destination.hostname) {
        return true;
    }

    if (!allowedHost.startsWith('*.')) {
        return false;
    }

    const suffix = allowedHost.slice(1);
    return destination.hostname.endsWith(suffix) && destination.hostname.length > suffix.length;
}

function resolveMaxPayloadBytes(request: any, context: any): number {
    const control = request?.control ?? {};
    const options = getRemoteBrowserRunnerOptions(context);
    const value = request.maxRemotePayloadBytes ??
        request.maxPayloadBytes ??
        control.maxPayloadBytes ??
        options.maxRemotePayloadBytes ??
        options.maxPayloadBytes ??
        DEFAULT_MAX_PAYLOAD_BYTES;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PAYLOAD_BYTES;
}

function computePayloadByteLength(value: any): number {
    if (value === undefined || value === null) {
        return 0;
    }

    const text = typeof value === 'string'
        ? value
        : JSON.stringify(value) ?? '';
    return new TextEncoder().encode(text).length;
}
