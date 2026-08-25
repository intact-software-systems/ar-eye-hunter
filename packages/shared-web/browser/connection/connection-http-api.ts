import type { ApiConfig, IceConfig } from '@shared/api/api-config.ts';

import { readApiBaseUrl } from '../api-client-config.ts';
import { executeHttpRequest, type ApiRequestOptions } from '../api/http-request.ts';

export async function readApiConfig(options?: ApiRequestOptions): Promise<ApiConfig> {
    return await executeHttpRequest<void, ApiConfig>(
        readApiBaseUrl(),
        '/api/config',
        'GET',
        undefined,
        options
    );
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
