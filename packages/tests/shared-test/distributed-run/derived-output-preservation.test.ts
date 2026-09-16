import { describe, expect, it } from 'vitest';

import { computeDistributedRunFailureEvidenceDestinations } from '../../../shared-test/rallar-bb-test/distributed-run-evidence.ts';
import { createDistributedRunMonitorIndex } from '../../../shared-test/rallar-bb-test/distributed-run-monitor-index.ts';
import { deriveDistributedRunMonitor } from '../../../shared-test/rallar-bb-test/distributed-run-monitor.ts';
import {
    createDistributedRunMonitorFailureIndex
} from '../../../shared-test/rallar-bb-test/distributed-run-observation/distributed-run-monitor-failure-index.ts';
import { computeDistributedRunTuningInventory } from '../../../shared-test/rallar-bb-test/distributed-run-tuning.ts';
import { decodeDistributedRunManifest } from '../../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import {
    resolveDistributedRunTargets,
    resolveDistributedTargetAgentIds
} from '../../../shared-test/rallar-bb-test/distributed/resolve-distributed-run-targets.ts';
import {
    resolveGroupMemberControlAgentMatches
} from '../../../shared-test/rallar-bb-test/distributed/resolve-group-member-control-agent-matches.ts';
import { createRecipeConsoleTuneScaleFixture } from '../../../shared-test/rallar-bb-test/recipe-console-tune-scale-fixture.ts';
import {
    createMonitorPreservationInput,
    PRESERVATION_NOW_EPOCH_MS,
    PRESERVATION_STALE_AFTER_MS,
    readCommittedManifests,
    toGroupMembers,
    toInvalidManifestVariants,
    toManifestTargetAgents,
    toPreservationDigest
} from './derived-output-preservation-fixtures.ts';

// Digests (SHA-256 and JSON length) captured by running the same explicit inputs through the
// implementation before the B6b contract closure (b83bd1f57). They guard the renames and the owner
// split: every derived output of an explicit manifest must stay byte-identical.
const COMMITTED_VALIDATION = '8606fc7d62adf6f8182d3216ea5f8ee032cbecb235f8ac11fd507bf5588bbdd2:5322';
const INVALID_VARIANT_VALIDATION = [
    'b5afbca45b741a3ae25128031e3e727258f32b486ffd9cf245d92790350982ad:95',
    '62571f0b46b11cc11eafc191570d688a0e493536a88e7500e0693218ba0e9f29:92',
    'b1189962b36b7629a035bf96ed501f3b0df093cfa2e2703c5e9a9b5bc393bd1b:541',
    'f6f3f3bb919d55041838ef016594c27759bc2e283721e5ba6ba940a86c9470e2:104',
    '75a7101e27a37a0ed1913513c311d18469107d31f69ac150fd3855d8619acf81:130',
    'b46033011ca8778ef95ccec3507d4b6663d74f3694624894676aae8cc8f9f0c2:79',
    '49990c263f1e6b0b78049169b36b5258d16689ebf6303a89b093e9980f7d94d1:84',
    'f0a42e991393c70f14d37fc6f9176ae0cb3f1b96259a20dd2c172295f7308d1c:285',
    '419a8871715caab0179c03b088a7f872847e34650203a72ebcad41829ce06f9c:76',
    'e15249d3684d533476ef82ce7409b2197e3c30f0c1ba536a80937833a346bd54:479'
];
const COMMITTED_INVENTORIES = '11aa76f508306e971a40d373da20ba7841ea651198b051a214a6aa0f1379fe5e:403483';
const TUNE_SCALE_INVENTORY = '7337a1a6e65f63729640009420170ed2d655948283d9d51fb750562d6430ce19:8564780';
const COMMITTED_TARGETS = '58df20d6b52665881024e4c42040aa068c241914016085d1f4f063f6f225b0f0:2111834';
const MONITOR_INDEX = '8ac363aea0514a937fba0cba12eff13c0183cd75d4eb49cd4d757987482c539a:472380';
const MONITOR = 'dc997c9fc3775d0f88fa56b61459e7c7ccac9adb85c5ec36e60d9da679498d38:378133';
const FAILURE_INDEX = '977cf1b64351494e3617ecd00d463e1268e9c0206b0e746a97709c28aa75733a:4011';
const EVIDENCE_DESTINATIONS = 'b0854425fae3cc66df8c4c172d6628ac4f9a95f005768794f57d95a4ea0d5c2a:98716';

describe('distributed run derived outputs for explicit manifests', () => {
    const manifests = readCommittedManifests();

    it('validates the committed manifests and one-rule invalid variants as before', () => {
        const groupAssertionManifest = manifests.find(({ path }) => path.includes('17-group-assertions'))!.manifest;

        expect(manifests).toHaveLength(74);
        expect(toPreservationDigest(manifests.map(({ path, manifest }) => [path, toValidationIssues(manifest)])))
            .toBe(COMMITTED_VALIDATION);
        expect(toInvalidManifestVariants(groupAssertionManifest).map((variant) => toPreservationDigest(toValidationIssues(variant)))).toEqual(
            INVALID_VARIANT_VALIDATION
        );
    });

    it('inventories the tuning knobs of the committed manifests and the scale fixture as before', () => {
        expect(toPreservationDigest(
            manifests.map(({ path, manifest }) => [path, computeDistributedRunTuningInventory(manifest)])
        )).toBe(COMMITTED_INVENTORIES);
        expect(toPreservationDigest(computeDistributedRunTuningInventory(createRecipeConsoleTuneScaleFixture().manifest)))
            .toBe(TUNE_SCALE_INVENTORY);
    });

    it('resolves targets and group member matches for the committed manifests as before', () => {
        const clock = { nowEpochMs: PRESERVATION_NOW_EPOCH_MS, staleAfterMs: PRESERVATION_STALE_AFTER_MS };
        const outputs = manifests.map(({ path, manifest }) => {
            const agents = toManifestTargetAgents(manifest);
            const matchResult = resolveGroupMemberControlAgentMatches({
                group: manifest.group,
                members: toGroupMembers(agents),
                agents,
                ...clock
            });
            return [
                path,
                resolveDistributedRunTargets({ manifest, agents, ...clock }),
                matchResult,
                resolveDistributedTargetAgentIds({ matchResult, targetPolicy: manifest.targetPolicy })
            ];
        });

        expect(toPreservationDigest(outputs)).toBe(COMMITTED_TARGETS);
    });

    it('indexes the monitor, its failures and their evidence destinations as before', () => {
        const input = createMonitorPreservationInput();
        const monitor = deriveDistributedRunMonitor(input);

        expect(toPreservationDigest(createDistributedRunMonitorIndex(input))).toBe(MONITOR_INDEX);
        expect(toPreservationDigest(monitor)).toBe(MONITOR);
        expect(toPreservationDigest(
            createDistributedRunMonitorFailureIndex(monitor.failures, createDistributedRunMonitorIndex(input))
        )).toBe(FAILURE_INDEX);
        expect(toPreservationDigest(
            monitor.failures.map((failure) => computeDistributedRunFailureEvidenceDestinations({ failure, monitor }))
        )).toBe(EVIDENCE_DESTINATIONS);
    });
});

function toValidationIssues(value: object) {
    return decodeDistributedRunManifest(value).left ?? [];
}
