import {
    formatDistributedRunManifestValidationErrors,
    validateDistributedRunManifest,
} from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

export function validateDistributedRecipeManifest(
    manifest: RallarBlackBoxDistributedRunManifest,
): string | undefined {
    const validation = validateDistributedRunManifest(manifest);
    return validation.ok
        ? undefined
        : formatDistributedRunManifestValidationErrors(validation.errors);
}
