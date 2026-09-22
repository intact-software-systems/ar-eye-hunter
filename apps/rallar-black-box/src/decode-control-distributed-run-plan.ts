import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeArrayItems } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/artifact-json-value-guards.ts';
import { decodeTargetResolution } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import {
    decodeDistributedRunManifest,
    toDistributedRunManifestValidationText
} from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '@shared/resilience/Either.ts';

/** The manifest and target resolution a distributed run reply carries, which the monitor and targeting read. */
export type ControlDistributedRunPlan = Pick<ControlDistributedRunSnapshot, 'manifest' | 'targetResolution'>;

/** A control server reply's distributed run plan; the rest of the reply is left to the reader that owns it. */
export function decodeControlDistributedRunPlan(
    value: unknown,
    path: string
): Either<string, ControlDistributedRunPlan> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(`Control server snapshot ${path} must be an object.`);
    }
    const { targetResolution } = value;
    return decodeDistributedRunManifest(value.manifest).flatMap(
        (issues) =>
            Either.ofLeft(
                `Control server snapshot ${path}.manifest is not a distributed run manifest:\n${
                    toDistributedRunManifestValidationText(issues)
                }`
            ),
        (manifest) =>
            targetResolution === undefined
                ? Either.ofRight({ manifest })
                : decodeTargetResolution(targetResolution).mapBoth(
                    (issue) => `Control server snapshot ${path}.${issue}.`,
                    (decodedResolution) => ({ manifest, targetResolution: decodedResolution })
                )
    );
}

/** The plans of a control server's distributed run list reply. */
export function decodeControlDistributedRunPlans(value: unknown): Either<string, readonly ControlDistributedRunPlan[]> {
    return Array.isArray(value)
        ? decodeArrayItems(value, 'distributedRuns', decodeControlDistributedRunPlan)
        : Either.ofLeft('Control server snapshot distributedRuns must be an array.');
}
