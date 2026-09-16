import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import type { RallarServerEndpointPreset, RallarServerRestMethod } from './rallar-server-workbench-contracts.ts';

const REST_METHODS: readonly RallarServerRestMethod[] = ['GET', 'POST', 'PUT', 'DELETE'];

export function decodeRallarServerOpenApiEndpoints(value: unknown): readonly RallarServerEndpointPreset[] {
    const paths = isJsonRecordValue(value) && isJsonRecordValue(value.paths) ? value.paths : {};
    return Object.entries(paths).flatMap(([pathTemplate, operations]) =>
        Object.entries(isJsonRecordValue(operations) ? operations : {}).flatMap(([method, operation]) => {
            const restMethod = REST_METHODS.find((candidate) => candidate === method.toUpperCase());
            return restMethod ? [toOpenApiEndpoint({ pathTemplate, method, restMethod, operation })] : [];
        })
    );
}

interface OpenApiOperationSource {
    readonly pathTemplate: string;
    readonly method: string;
    readonly restMethod: RallarServerRestMethod;
    readonly operation: unknown;
}

function toOpenApiEndpoint(
    { pathTemplate, method, restMethod, operation }: OpenApiOperationSource
): RallarServerEndpointPreset {
    const record = isJsonRecordValue(operation) ? operation : {};
    const tags = Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    return {
        presetId: `openapi-${method}-${pathTemplate.replace(/[^A-Za-z0-9]+/g, '-')}`,
        tag: tags[0] ?? 'OpenAPI',
        label: typeof record.summary === 'string' ? record.summary : `${restMethod} ${pathTemplate}`,
        method: restMethod,
        pathTemplate,
        requiresAuth: Array.isArray(record.security)
    };
}
