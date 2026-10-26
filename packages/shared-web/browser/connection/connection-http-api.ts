import type { ApiConfigResponse, IceConfig } from '@shared/api/api-config.ts';
import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiRequestOptions } from '../api/http-request.ts';
import { decodeApiConfigResponse } from './decode-api-config-response.ts';

export async function readApiConfig(options?: ApiRequestOptions): Promise<ApiConfigResponse> {
    const apiBaseUrl = readApiBaseUrl();
    const apiUrl = URL.parse(`${apiBaseUrl}/api/config`, globalThis.document?.baseURI ?? globalThis.location?.href);
    if (
        apiUrl === null || (apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') ||
        apiUrl.username !== '' || apiUrl.password !== ''
    ) {
        throw new Error('The configured Rallar API base URL is invalid.');
    }
    const decoded = decodeApiConfigResponse(
        await executeHttpRequest<void, ApiJsonValue>(
            apiBaseUrl,
            '/api/config',
            'GET',
            undefined,
            options
        ),
        apiUrl
    );
    if (decoded.left !== undefined) {
        throw new Error(decoded.left);
    }
    return decoded.right!;
}

export async function readIceCandidates(
    options?: ApiRequestOptions,
    apiBaseUrl = readApiBaseUrl()
): Promise<IceConfig> {
    const response = await executeHttpRequest<void, ApiJsonValue>(
        apiBaseUrl,
        '/api/webrtc/ice',
        'GET',
        undefined,
        options
    );
    const issues = validateIceConfigResponse(response, Date.now());
    if (issues.length > 0) {
        throw new Error(issues.join('; '));
    }
    return response as ApiJsonObject & IceConfig;
}

function validateIceConfigResponse(response: ApiJsonValue, nowEpochMs: number): readonly string[] {
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
        return ['ICE configuration must be an object.'];
    }
    const config = response as ApiJsonObject;
    const issues: string[] = [];
    if (
        typeof config.expiresAtEpochMs !== 'number' || !Number.isFinite(config.expiresAtEpochMs) ||
        config.expiresAtEpochMs <= nowEpochMs
    ) {
        issues.push('ICE configuration must have a finite future expiry.');
    }
    if (!Array.isArray(config.iceServers)) {
        issues.push('ICE configuration must have an iceServers array.');
    }
    else {
        for (const server of config.iceServers) {
            issues.push(...validateIceServer(server));
        }
    }
    return issues;
}

function validateIceServer(response: ApiJsonValue): readonly string[] {
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
        return ['ICE server must be an object.'];
    }
    const server = response as ApiJsonObject;
    const issues: string[] = [];
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (
        !Array.isArray(urls) || urls.length === 0 ||
        urls.some((url) => typeof url !== 'string' || url.trim().length === 0)
    ) {
        issues.push('ICE server must have non-empty URL strings.');
    }
    if (server.username !== undefined && typeof server.username !== 'string') {
        issues.push('ICE server username must be a string.');
    }
    if (server.credential !== undefined && typeof server.credential !== 'string') {
        issues.push('ICE server credential must be a string.');
    }
    return issues;
}
