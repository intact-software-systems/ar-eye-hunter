import {
    validateDistributedRunManifestContract,
    type RallarBlackBoxDistributedRunManifest,
    type RallarBlackBoxDistributedRunValidationResult,
} from './distributed-run.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    validateJsonSchema,
    type JsonSchemaValidationResult,
} from './schema.ts';

export type DistributedRunManifestValidationIssue = Readonly<{
    source: 'schema' | 'contract';
    path: string;
    message: string;
}>;

export type DistributedRunManifestValidationResult = Readonly<{
    ok: boolean;
    schemaValidation: JsonSchemaValidationResult;
    contractValidation?: RallarBlackBoxDistributedRunValidationResult;
    errors: readonly DistributedRunManifestValidationIssue[];
}>;

export function validateDistributedRunManifest(
    value: unknown,
): DistributedRunManifestValidationResult {
    const schemaValidation = validateJsonSchema(
        RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
        value,
    );
    if (!schemaValidation.ok) {
        return {
            ok: false,
            schemaValidation,
            errors: schemaValidation.errors.map((error) => ({
                source: 'schema' as const,
                path: error.path,
                message: error.message,
            })),
        };
    }

    const contractValidation = validateDistributedRunManifestContract(
        value as RallarBlackBoxDistributedRunManifest,
    );
    if (!contractValidation.ok) {
        return {
            ok: false,
            schemaValidation,
            contractValidation,
            errors: contractValidation.errors.map((error) => ({
                source: 'contract' as const,
                path: error.path,
                message: error.message,
            })),
        };
    }

    return {
        ok: true,
        schemaValidation,
        contractValidation,
        errors: [],
    };
}

export function formatDistributedRunManifestValidationErrors(
    errors: readonly DistributedRunManifestValidationIssue[],
): string {
    return errors.map((error) => `${error.path}: ${error.message}`).join('\n');
}
