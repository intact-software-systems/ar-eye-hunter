import type { ApiConfig } from '@shared/api/api-config.ts';

import type { ApiV1PublicApiConfiguration } from './api-v1-configuration.ts';

export function toApiV1PublicConfiguration(
    configuration: ApiV1PublicApiConfiguration
): ApiConfig {
    return {
        apiBaseUrl: configuration.apiBaseUrl,
        wsBaseUrl: configuration.wsBaseUrl,
        endpoints: {
            createWs: '/api/ws/:id'
        }
    };
}
