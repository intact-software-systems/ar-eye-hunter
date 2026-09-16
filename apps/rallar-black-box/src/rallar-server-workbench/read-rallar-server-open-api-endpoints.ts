import { Either } from '@shared/resilience/Either.ts';
import { decodeRallarServerOpenApiEndpoints } from './decode-rallar-server-open-api-endpoints.ts';
import type { RallarServerEndpointPreset } from './rallar-server-workbench-contracts.ts';
import { toRallarServerBaseUrl } from './to-rallar-server-base-url.ts';

export interface ReadRallarServerOpenApiEndpointsInput {
    readonly apiBaseUrl: string;
    readonly fetch: typeof fetch;
}

export async function readRallarServerOpenApiEndpoints(
    { apiBaseUrl, fetch: fetchResource }: ReadRallarServerOpenApiEndpointsInput
): Promise<Either<string, readonly RallarServerEndpointPreset[]>> {
    return await toRallarServerBaseUrl({ apiBaseUrl, forbidPlaceholderBaseUrl: false }).fold(
        async (error) => Either.ofLeft<string, readonly RallarServerEndpointPreset[]>(error),
        async (baseUrl) => {
            try {
                const response = await fetchResource(new URL('/api/openapi.json', baseUrl).toString());
                return response.ok
                    ? Either.ofRight<string, readonly RallarServerEndpointPreset[]>(
                        decodeRallarServerOpenApiEndpoints(await response.json())
                    )
                    : Either.ofLeft<string, readonly RallarServerEndpointPreset[]>(
                        `OpenAPI request failed: ${response.status}`
                    );
            }
            catch (error) {
                return Either.ofLeft<string, readonly RallarServerEndpointPreset[]>(
                    error instanceof Error ? error.message : String(error)
                );
            }
        }
    );
}
