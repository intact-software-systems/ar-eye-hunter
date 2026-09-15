import {
    validateDistributedRunManifestContract,
    type RallarBlackBoxDistributedRunManifest
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    validateJsonSchema
} from '@shared-test/rallar-bb-test/schema.ts';
import { Either } from '@shared/resilience/Either.ts';

export function decodeDistributedRunManifestRequest(
    body: unknown
): Either<string, RallarBlackBoxDistributedRunManifest> {
    const manifest = typeof body === 'object' && body !== null && 'manifest' in body ? body.manifest : body;
    const schemaValidation = validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, manifest);
    if (!schemaValidation.ok) {
        return Either.ofLeft(formatJsonSchemaValidationErrors(schemaValidation.errors));
    }

    const schemaValidManifest = manifest as RallarBlackBoxDistributedRunManifest;
    const contractValidation = validateDistributedRunManifestContract(schemaValidManifest);
    if (!contractValidation.ok) {
        return Either.ofLeft(
            contractValidation.errors.map((error) => `${error.path}: ${error.message}`).join('\n')
        );
    }
    return Either.ofRight(schemaValidManifest);
}
