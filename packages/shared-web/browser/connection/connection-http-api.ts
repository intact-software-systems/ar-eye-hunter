import type { ApiConfigResponse, IceConfig } from '@shared/api/api-config.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiRequestOptions } from '../api/http-request.ts';
import { decodeApiConfigResponse } from './decode-api-config-response.ts';

export async function readApiConfig(options?: ApiRequestOptions): Promise<ApiConfigResponse> {
    const decoded = decodeApiConfigResponse(
        await executeHttpRequest<void, ApiJsonValue>(
            readApiBaseUrl(),
            '/api/config',
            'GET',
            undefined,
            options
        )
    );
    if (decoded.left !== undefined) {
        throw new Error(decoded.left);
    }
    return decoded.right!;
}

export async function readIceCandidates(options?: ApiRequestOptions): Promise<IceConfig> {
    return await executeHttpRequest<void, IceConfig>(
        readApiBaseUrl(),
        '/api/webrtc/ice',
        'GET',
        undefined,
        options
    );
}
