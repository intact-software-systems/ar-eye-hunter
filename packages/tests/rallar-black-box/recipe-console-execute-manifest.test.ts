import { describe, expect, it } from 'vitest';
import {
    compareExecuteTargetResolution,
    createExecuteDistributedRunId,
    createExecuteTargetResolutionEvidence,
    currentExecuteTargetResolutionEvidence,
    deriveExecuteManifest,
    executeManifestFingerprint,
    projectExecuteManifest,
} from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-manifest.ts';
import {
    projectDistributedRecipeCatalog,
    type DistributedRecipeCatalogEntryProjection,
} from '../../../packages/shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

const GROUP: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'app-a',
    workspaceId: 'workspace-a',
    groupId: 'group-a',
};

function selectedRecipe(): DistributedRecipeCatalogEntryProjection {
    const entry = projectDistributedRecipeCatalog({
        configuration: {
            group: GROUP,
            apiBaseUrl: 'https://api.example.test',
            rtcRealtimeDurationSeconds: 5,
        },
    }).entries.find((candidate) => candidate.schema.status === 'valid');
    if (!entry) throw new Error('The shared catalog needs one schema-valid recipe.');
    return entry;
}

function manifestDraft() {
    return deriveExecuteManifest({
        distributedRunId: 'distributed-explicit-a',
        controlRunId: 'control-a',
        group: GROUP,
        selectedRecipe: selectedRecipe(),
        selectedAgentIds: ['agent-b', 'agent-a', 'agent-b'],
    });
}

function targetResolution(
    manifest: RallarBlackBoxDistributedRunManifest,
    overrides: Partial<RallarBlackBoxDistributedTargetResolution> = {},
): RallarBlackBoxDistributedTargetResolution {
    const targetAgentIds = manifest.targetPolicy.agentIds ?? [];
    const expectedParticipantCount =
        manifest.targetPolicy.expectedParticipantCount;
    return {
        group: manifest.group,
        resolvedAtEpochMs: 10_000,
        staleAfterMs: 15_000,
        targetPolicyMode: manifest.targetPolicy.mode,
        targetAgentIds: [...targetAgentIds].reverse(),
        roleAssignments: manifest.roleAssignments ?? [],
        blockers: [],
        summary: {
            agents: targetAgentIds.length + 1,
            targetable: targetAgentIds.length,
            selected: targetAgentIds.length,
            expectedParticipantCount,
            missingExpectedParticipants: 0,
            staleAgents: 0,
            offlineAgents: 0,
            wrongGroupAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: {},
            regions: {},
            providers: {},
        },
        ...overrides,
    };
}

describe('Recipe Console Execute manifest', () => {
    it('creates a deterministic run ID only from explicit inputs', () => {
        const input = {
            controlRunId: 'Control Run / A',
            group: GROUP,
            recipeId: 'RTC Stability / Green',
            requestedAtEpochMs: 1_725_000_000_123,
        } as const;

        const first = createExecuteDistributedRunId(input);
        const second = createExecuteDistributedRunId({ ...input });

        expect(first).toBe(second);
        expect(first).toMatch(/^dist-group-a-rtc-stability-green-control-run-a-1725000000123$/);
        expect(createExecuteDistributedRunId({
            ...input,
            requestedAtEpochMs: input.requestedAtEpochMs + 1,
        })).not.toBe(first);
        expect(() => createExecuteDistributedRunId({
            ...input,
            requestedAtEpochMs: Number.NaN,
        })).toThrow('requestedAtEpochMs');
    });

    it('uses the shared builder for one selected recipe and exact safe targets', () => {
        const draft = manifestDraft();

        expect(draft.manifest).toMatchObject({
            schemaVersion: 1,
            distributedRunId: 'distributed-explicit-a',
            controlRunId: 'control-a',
            displayName: selectedRecipe().item.title,
            group: GROUP,
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: ['agent-a', 'agent-b'],
                expectedParticipantCount: 2,
            },
            ackTimeoutMs: 15_000,
            startMode: 'manual',
            metadata: {
                createdBy: 'rallar-black-box-spa',
                rolePattern: 'all-agents',
            },
        });
        expect(draft.manifest.recipes).toHaveLength(1);
        expect(draft.manifest.recipes[0]?.recipe).toEqual(selectedRecipe().item.recipe);
        expect(draft.validation).toMatchObject({ ok: true, errors: [] });
        expect(JSON.parse(draft.rawJson)).toEqual(draft.manifest);
        expect(draft.rawJson).toContain('\n  "distributedRunId"');
        expect(draft.fingerprint).toBe(executeManifestFingerprint(draft.manifest));
    });

    it('projects an authoritative stored manifest without rebuilding its intent', () => {
        const generated = manifestDraft();
        const stored = {
            ...generated.manifest,
            displayName: 'Authoritative server draft',
            targetPolicy: {
                ...generated.manifest.targetPolicy,
                agentIds: ['agent-b'],
                expectedParticipantCount: 1,
            },
        };

        const projected = projectExecuteManifest(stored);

        expect(projected.manifest).toBe(stored);
        expect(JSON.parse(projected.rawJson)).toEqual(stored);
        expect(projected.validation.ok).toBe(true);
        expect(projected.fingerprint).toBe(executeManifestFingerprint(stored));
    });

    it('fingerprints the complete recursive value without key-order or framing collisions', () => {
        const ordered = {
            string: '1',
            nested: { alpha: true, beta: [1, null, undefined] },
        };
        const reordered = {
            nested: { beta: [1, null, undefined], alpha: true },
            string: '1',
        };

        expect(executeManifestFingerprint(ordered as never))
            .toBe(executeManifestFingerprint(reordered as never));
        for (const different of [
            { string: 1, nested: ordered.nested },
            { string: '1', nested: { alpha: true, beta: [1, undefined, null] } },
            { string: '1', nested: { alpha: true, beta: [1, null] } },
            { string: '1', nested: { alpha: true, beta: [1, null] }, extra: undefined },
            { a: 'b:c', d: 'e' },
            { a: 'b', c: 'd:e' },
        ]) {
            expect(executeManifestFingerprint(different as never))
                .not.toBe(executeManifestFingerprint(ordered as never));
        }
        expect(executeManifestFingerprint({ a: 'b:c', d: 'e' } as never))
            .not.toBe(executeManifestFingerprint({ a: 'b', c: 'd:e' } as never));

        const leadingHole = new Array<unknown>(2);
        leadingHole[1] = 'agent-a';
        const trailingHole = new Array<unknown>(2);
        trailingHole[0] = 'agent-a';
        expect(executeManifestFingerprint(leadingHole as never))
            .not.toBe(executeManifestFingerprint(trailingHole as never));
    });

    it('accepts only an exact duplicate-free selected-target resolution', () => {
        const { manifest } = manifestDraft();
        const unrelatedBlocker = {
            agentId: 'agent-unrelated',
            status: 'offline-agent' as const,
            reason: 'An unrelated known agent is offline.',
        };
        const matching = targetResolution(manifest, {
            blockers: [unrelatedBlocker],
        });

        expect(compareExecuteTargetResolution({ manifest, resolution: matching }))
            .toEqual({ ok: true, issues: [] });

        const cases: readonly [
            string,
            RallarBlackBoxDistributedRunManifest,
            RallarBlackBoxDistributedTargetResolution,
            string,
        ][] = [
            [
                'group drift',
                manifest,
                targetResolution(manifest, {
                    group: { ...GROUP, groupId: 'group-b' },
                }),
                'group-mismatch',
            ],
            [
                'policy drift',
                manifest,
                targetResolution(manifest, {
                    targetPolicyMode: 'all-online-group-members',
                }),
                'policy-mismatch',
            ],
            [
                'duplicate selected IDs',
                {
                    ...manifest,
                    targetPolicy: {
                        ...manifest.targetPolicy,
                        agentIds: ['agent-a', 'agent-a'],
                    },
                },
                matching,
                'duplicate-selected-target',
            ],
            [
                'duplicate resolved IDs',
                manifest,
                targetResolution(manifest, {
                    targetAgentIds: ['agent-a', 'agent-a'],
                }),
                'duplicate-resolved-target',
            ],
            [
                'target drift',
                manifest,
                targetResolution(manifest, { targetAgentIds: ['agent-a'] }),
                'target-mismatch',
            ],
            [
                'expected count drift',
                manifest,
                targetResolution(manifest, {
                    summary: {
                        ...matching.summary,
                        expectedParticipantCount: 3,
                    },
                }),
                'expected-count-mismatch',
            ],
            [
                'missing participants',
                manifest,
                targetResolution(manifest, {
                    summary: {
                        ...matching.summary,
                        missingExpectedParticipants: 1,
                    },
                }),
                'missing-participants',
            ],
            [
                'selected blocker',
                manifest,
                targetResolution(manifest, {
                    blockers: [{
                        agentId: 'agent-a',
                        status: 'stale-agent',
                        reason: 'The selected agent became stale.',
                    }],
                }),
                'selected-target-blocked',
            ],
        ];

        for (const [label, candidateManifest, resolution, issueCode] of cases) {
            const comparison = compareExecuteTargetResolution({
                manifest: candidateManifest,
                resolution,
            });
            expect(comparison.ok, label).toBe(false);
            expect(comparison.issues.map((issue) => issue.code), label)
                .toContain(issueCode);
        }
    });

    it('stores the full manifest fingerprint and invalidates evidence for every draft field', () => {
        const { manifest } = manifestDraft();
        const resolution = targetResolution(manifest);
        const evidence = createExecuteTargetResolutionEvidence({
            manifest,
            resolution,
        });

        expect(evidence.manifestFingerprint).toBe(
            executeManifestFingerprint(manifest),
        );
        expect(currentExecuteTargetResolutionEvidence({ manifest, evidence }))
            .toBe(evidence);

        const changes: readonly RallarBlackBoxDistributedRunManifest[] = [
            { ...manifest, schemaVersion: undefined },
            { ...manifest, distributedRunId: 'distributed-changed' },
            { ...manifest, controlRunId: 'control-changed' },
            { ...manifest, displayName: 'Changed display name' },
            { ...manifest, description: 'Changed description' },
            { ...manifest, group: { ...manifest.group, applicationId: 'app-b' } },
            { ...manifest, group: { ...manifest.group, workspaceId: 'workspace-b' } },
            { ...manifest, group: { ...manifest.group, groupId: 'group-b' } },
            {
                ...manifest,
                recipes: manifest.recipes.map((recipe, index) =>
                    index === 0 ? { ...recipe, profile: 'changed-profile' } : recipe
                ),
            },
            {
                ...manifest,
                targetPolicy: {
                    ...manifest.targetPolicy,
                    agentIds: ['agent-a'],
                    expectedParticipantCount: 1,
                },
            },
            { ...manifest, variables: { changed: true } },
            { ...manifest, secretRefs: ['changed-secret'] },
            {
                ...manifest,
                roleAssignments: [{
                    agentId: 'agent-a',
                    role: 'changed-role',
                    required: true,
                }],
            },
            {
                ...manifest,
                roleAssignmentPolicy: {
                    mode: 'ordered-targets',
                    pattern: 'sender-receiver',
                    orderBy: 'agent-id',
                },
            },
            { ...manifest, ackTimeoutMs: 15_001 },
            { ...manifest, barrier: { enabled: true, timeoutMs: 15_000 } },
            { ...manifest, startMode: 'auto-after-ready' },
            { ...manifest, startDeadlineEpochMs: 123_456 },
            {
                ...manifest,
                artifactPolicy: {
                    ...manifest.artifactPolicy,
                    retentionDays: 7,
                },
            },
            { ...manifest, metadata: { ...manifest.metadata, changed: true } },
        ];

        for (const changed of changes) {
            expect(
                currentExecuteTargetResolutionEvidence({
                    manifest: changed,
                    evidence,
                }),
                JSON.stringify(changed),
            ).toBeUndefined();
        }
        expect(currentExecuteTargetResolutionEvidence({
            manifest,
            evidence: undefined,
        })).toBeUndefined();
    });
});
