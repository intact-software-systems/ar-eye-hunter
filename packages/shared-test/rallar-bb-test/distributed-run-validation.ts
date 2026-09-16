import { Either } from '@shared/resilience/Either.ts';

import {
    validateDistributedRunManifestContract,
    type RallarBlackBoxDistributedRunManifest
} from './distributed-run.ts';
import { RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA } from './schema.ts';
import { validateJsonSchema } from './schema/json-schema-validation.ts';

export interface DistributedRunManifestValidationIssue {
    readonly source: 'schema' | 'contract';
    readonly path: string;
    readonly message: string;
}

/**
 * A manifest from JSON: the schema checks its shape and every author setting, and the contract checks
 * the cross-field rules only once that shape holds.
 */
export function decodeDistributedRunManifest(
    value: unknown
): Either<readonly DistributedRunManifestValidationIssue[], RallarBlackBoxDistributedRunManifest> {
    const schemaValidation = validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, value);
    if (!schemaValidation.ok) {
        return Either.ofLeft(schemaValidation.errors.map((error) => ({
            source: 'schema' as const,
            path: error.path,
            message: error.message
        })));
    }

    const manifest = value as RallarBlackBoxDistributedRunManifest;
    const contractIssues = validateDistributedRunManifestContract(manifest);
    return contractIssues.length === 0
        ? Either.ofRight(manifest)
        : Either.ofLeft(contractIssues.map((issue) => ({
            source: 'contract' as const,
            path: issue.path,
            message: issue.message
        })));
}

/** Every issue a typed manifest still has against the schema and contract; empty when it is valid. */
export function validateDistributedRunManifest(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly DistributedRunManifestValidationIssue[] {
    return decodeDistributedRunManifest(manifest).left ?? [];
}

export function toDistributedRunManifestValidationText(
    issues: readonly DistributedRunManifestValidationIssue[]
): string {
    return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}
