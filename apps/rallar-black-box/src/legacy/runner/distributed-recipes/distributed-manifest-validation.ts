import {
    toDistributedRunManifestValidationText,
    validateDistributedRunManifest
} from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';

export function validateDistributedRecipeManifest(
    manifest: RallarBlackBoxDistributedRunManifest
): string | undefined {
    const issues = validateDistributedRunManifest(manifest);
    return issues.length === 0
        ? undefined
        : toDistributedRunManifestValidationText(issues);
}
