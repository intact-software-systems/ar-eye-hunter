import {
    decodeDistributedRunManifest,
    toDistributedRunManifestValidationText
} from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

const DEFAULT_CANCEL_REASON = 'Distributed run cancelled.';

export function decodeDistributedRunManifestRequest(
    body: unknown
): Either<string, RallarBlackBoxDistributedRunManifest> {
    const manifest = isJsonRecordValue(body) && 'manifest' in body ? body.manifest : body;
    return decodeDistributedRunManifest(manifest).mapLeft(toDistributedRunManifestValidationText);
}

export function decodeDistributedRunCancelReason(body: unknown): string {
    const reason = isJsonRecordValue(body) && typeof body.reason === 'string' ? body.reason.trim() : '';
    return reason.length > 0 ? reason : DEFAULT_CANCEL_REASON;
}
