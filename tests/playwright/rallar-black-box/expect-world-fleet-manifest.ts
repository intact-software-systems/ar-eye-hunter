import { deepStrictEqual, strictEqual } from 'node:assert';

import { applyWorldFleetCaptureMode } from '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxDistributedGroupAssertionResult } from '../../../packages/shared-test/rallar-bb-test/distributed/group-assertions.ts';
import { parseRtcCaptureMode } from '../../../packages/shared/webrtc/rtc-capture-configuration.ts';

/** Compare admitted execution intent without weakening the authored workload contract. */
export function expectWorldFleetManifest(
    actual: RallarBlackBoxDistributedRunManifest,
    authored: RallarBlackBoxDistributedRunManifest,
    captureInput: string | undefined
): void {
    const capture = parseRtcCaptureMode(captureInput?.trim() === '' ? undefined : captureInput).fold(
        (issues) => {
            throw new Error(issues.map((issue) => issue.message).join('\n'));
        },
        (selection) => selection
    );
    deepStrictEqual(actual, applyWorldFleetCaptureMode(authored, capture));
}

/** Assert the native group rows accepted by the full-stack observation. */
export function expectWorldFleetGroupAssertions(
    manifest: RallarBlackBoxDistributedRunManifest,
    results: readonly RallarBlackBoxDistributedGroupAssertionResult[] | undefined
): void {
    strictEqual(results?.length, manifest.groupAssertions.length);
    if (results === undefined) {
        return;
    }
    deepStrictEqual(
        results.map((result) => result.groupAssertionId).sort(),
        manifest.groupAssertions.map((assertion) => assertion.groupAssertionId).sort()
    );
    const expectedParticipantCount = manifest.targetPolicy.expectedParticipantCount;
    strictEqual(manifest.roleAssignments.length, expectedParticipantCount);
    strictEqual(
        new Set(manifest.roleAssignments.map((assignment) => assignment.agentId)).size,
        expectedParticipantCount
    );
    const byId = new Map(results.map((result) => [result.groupAssertionId, result]));
    for (const assertion of manifest.groupAssertions) {
        const result = byId.get(assertion.groupAssertionId)!;
        const scopeRole = assertion.scope?.role;
        const primary = manifest.roleAssignments.filter((assignment) =>
            scopeRole === undefined || assignment.role === scopeRole
        );
        const comparison = assertion.aggregate === 'sameUniqueStringSetAsRole'
            ? manifest.roleAssignments.filter((assignment) => assignment.role === assertion.comparison.role)
            : [];
        strictEqual(primary.length > 0, true);
        if (assertion.aggregate === 'sameUniqueStringSetAsRole') {
            strictEqual(comparison.length > 0, true);
        }
        const audience = [...primary, ...comparison];
        strictEqual(result.aggregate, assertion.aggregate);
        strictEqual(result.participants.expected, audience.length);
        strictEqual(
            result.participants.required,
            assertion.aggregate === 'sameUniqueStringSetAsRole'
                ? audience.length
                : assertion.minParticipants ?? audience.length
        );
        strictEqual(result.participants.withEvidence, audience.length);
        deepStrictEqual(
            result.perAgent.map((row) => ({ agentId: row.agentId, role: row.role }))
                .sort((left, right) => left.agentId.localeCompare(right.agentId)),
            audience.map((assignment) => ({ agentId: assignment.agentId, role: assignment.role }))
                .sort((left, right) => left.agentId.localeCompare(right.agentId))
        );
        strictEqual(result.ok, true);
        deepStrictEqual(result.missingAgentIds, []);
        deepStrictEqual(result.violatingAgentIds, []);
        strictEqual(result.error, undefined);
        strictEqual(result.perAgent.every((row) => row.evidence === 'resolved'), true);
        if (result.aggregate === 'allMatch') {
            strictEqual(result.participants.matching, audience.length);
            strictEqual(
                result.perAgent.every((row) => row.evidence === 'resolved' && row.verdict === 'matching'),
                true
            );
        }
        else if (result.aggregate === 'noneMatch') {
            strictEqual(result.participants.matching, 0);
            strictEqual(
                result.perAgent.every((row) => row.evidence === 'resolved' && row.verdict === 'not-matching'),
                true
            );
        }
        else if (result.aggregate === 'countMatching') {
            strictEqual(
                result.participants.matching,
                result.perAgent.filter((row) => row.evidence === 'resolved' && row.verdict === 'matching').length
            );
            strictEqual(
                result.perAgent.every((row) =>
                    row.evidence === 'resolved' && (row.verdict === 'matching' || row.verdict === 'not-matching')
                ),
                true
            );
        }
        else {
            strictEqual(
                result.perAgent.every((row) => row.evidence === 'resolved' && row.verdict === 'agreeing'),
                true
            );
        }
    }
}
