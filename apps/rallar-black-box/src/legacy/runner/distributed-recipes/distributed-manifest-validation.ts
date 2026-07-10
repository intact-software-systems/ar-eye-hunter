import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
} from '@shared-test/rallar-bb-test/schema.ts';
import {
    validateDistributedRunManifestContract,
    type RallarBlackBoxDistributedRunManifest,
} from '@shared-test/rallar-bb-test/distributed-run.ts';

export function validateDistributedRecipeManifest(
    manifest: RallarBlackBoxDistributedRunManifest,
): string | undefined {
    const schemaValidation = validateJsonSchema(
        RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
        manifest,
    );
    if (!schemaValidation.ok) {
        return formatJsonSchemaValidationErrors(schemaValidation.errors);
    }

    const contractValidation = validateDistributedRunManifestContract(manifest);
    if (!contractValidation.ok) {
        return contractValidation.errors
            .map((error) => `${error.path}: ${error.message}`)
            .join('\n');
    }

    return undefined;
}
