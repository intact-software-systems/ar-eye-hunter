import { describe, expect, it } from 'vitest';
import {
    resolveDistributedRunTargets,
    type RallarBlackBoxControlAgentCandidate,
    type RallarBlackBoxControlAgentCapabilities,
    type RallarBlackBoxDistributedRunManifest
} from '../../shared-test/rallar-bb-test/distributed-run.ts';
import {
    computeDistributedAssertionFeatures,
    decodeControlAgentCapabilities,
    toControlAgentCapabilities,
    validateAgentAssertionCapability
} from '../../shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts';
import type { RallarBlackBoxTestRecipe } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

const FULL_MESSAGING_CAPABILITY: RallarBlackBoxControlAgentCapabilities['messaging'] = {
    supported: true,
    carriers: ['ws', 'rtc', 'rtc-with-ws-fallback'],
    faults: true,
    storageCounters: true,
    reload: true
};

const NEW_FEATURE_RECIPE: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'gate-new-features',
    commands: [
        {
            kind: 'wait',
            commandId: 'gate-absence',
            absent: true,
            timeoutMs: 1_000,
            match: { kind: 'message', topic: 'room.gate.forbidden' }
        },
        {
            kind: 'loop',
            commandId: 'gate-until',
            until: 'first-success',
            count: 3,
            commands: [
                {
                    kind: 'assert',
                    commandId: 'gate-extended-assert',
                    source: 'state.commandHistory.length',
                    operator: 'gt',
                    expected: 0
                }
            ]
        }
    ]
};

const BASELINE_RECIPE: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'gate-baseline',
    commands: [
        { kind: 'health', commandId: 'gate-health' },
        {
            kind: 'assert',
            commandId: 'gate-baseline-assert',
            source: 'state.commandHistory.length',
            operator: 'gte',
            expected: 0
        }
    ]
};

function manifestWith(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxDistributedRunManifest {
    return {
        distributedRunId: `gate-${recipe.recipeId}`,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'gate-room'
        },
        recipes: [
            {
                recipeId: recipe.recipeId,
                required: true,
                recipe,
                variables: {},
                secretRefs: []
            }
        ],
        targetPolicy: {
            mode: 'all-online-group-members',
            expectedParticipantCount: 1,
            includeOfflineExpectedAgents: false
        },
        startMode: 'manual',
        schemaVersion: 1,
        controlRunId: `gate-${recipe.recipeId}`,
        variables: {},
        secretRefs: [],
        roleAssignments: [],
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
        artifactPolicy: {
            retainArtifacts: true,
            includeEventJsonl: true,
            includeResultJsonl: true,
            includeFailureBundle: true,
            includeDistributedMetadata: true
        },
        groupAssertions: [],
        metadata: {}
    };
}

function agentWith(
    capabilities: RallarBlackBoxControlAgentCapabilities
): RallarBlackBoxControlAgentCandidate {
    return {
        agentId: 'gate-agent',
        connected: true,
        lastHeartbeatAtEpochMs: 1_000,
        identity: {
            principalId: 'gate-principal',
            sessionId: 'gate-session',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'gate-room',
            capabilities,
            updatedAtEpochMs: 1_000
        }
    };
}

describe('rallar-bb-test assertion capability gate', () => {
    it('collects absence, until, and extended operator usage from inline recipes', () => {
        const features = computeDistributedAssertionFeatures([NEW_FEATURE_RECIPE]);
        expect(features).toEqual({
            absence: true,
            untilLoop: true,
            operators: ['gt']
        });

        expect(computeDistributedAssertionFeatures([BASELINE_RECIPE])).toEqual({
            absence: false,
            untilLoop: false,
            operators: []
        });
    });

    it('blocks staging targets for old-capability agents with a named reason', () => {
        const resolution = resolveDistributedRunTargets({
            manifest: manifestWith(NEW_FEATURE_RECIPE),
            agents: [agentWith({
                crdt: { supported: true, transports: [], apiBaseUrlConfigured: false },
                messaging: FULL_MESSAGING_CAPABILITY
            })],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });

        expect(resolution.targetAgentIds).toEqual([]);
        expect(resolution.blockers).toHaveLength(1);
        expect(resolution.blockers[0]).toMatchObject({
            agentId: 'gate-agent',
            status: 'missing-assertion-capability'
        });
        expect(resolution.blockers[0].reason).toContain('absence waits');
        expect(resolution.blockers[0].reason).toContain('until loops');
        expect(resolution.blockers[0].reason).toContain('assert operators: gt');
        expect(resolution.summary.assertionCapabilityBlockedAgents).toBe(1);
        expect(resolution.summary.missingExpectedParticipants).toBe(1);
    });

    it('stages a capability-complete fleet and leaves baseline manifests ungated', () => {
        const complete = agentWith(toControlAgentCapabilities({
            config: undefined,
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080'
        }));

        const gated = resolveDistributedRunTargets({
            manifest: manifestWith(NEW_FEATURE_RECIPE),
            agents: [complete],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(gated.targetAgentIds).toEqual(['gate-agent']);
        expect(gated.blockers).toEqual([]);

        const baseline = resolveDistributedRunTargets({
            manifest: manifestWith(BASELINE_RECIPE),
            agents: [agentWith({
                crdt: { supported: true, transports: [], apiBaseUrlConfigured: false },
                messaging: FULL_MESSAGING_CAPABILITY
            })],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(baseline.targetAgentIds).toEqual(['gate-agent']);
        expect(baseline.blockers).toEqual([]);
    });

    it('advertises the runtime feature set and survives the register-envelope parse', () => {
        const advertised = toControlAgentCapabilities({
            config: undefined,
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080'
        });
        expect(advertised.assertions).toMatchObject({
            absence: true,
            untilLoop: true
        });
        expect(advertised.assertions?.operators).toContain('matchesShapeComplete');

        const decoded = decodeControlAgentCapabilities(
            JSON.parse(JSON.stringify(advertised))
        );
        expect(decoded.right?.assertions).toEqual(advertised.assertions);
        expect(decoded.right?.crdt.supported).toBe(true);

        const legacyDecoded = decodeControlAgentCapabilities({
            crdt: { supported: true, transports: [], apiBaseUrlConfigured: false },
            messaging: FULL_MESSAGING_CAPABILITY
        });
        expect(legacyDecoded.right?.assertions).toBeUndefined();
        expect(validateAgentAssertionCapability(
            computeDistributedAssertionFeatures([NEW_FEATURE_RECIPE]),
            legacyDecoded.right
        )).toEqual(['absence waits', 'until loops', 'assert operators: gt']);
        expect(decodeControlAgentCapabilities({ crdt: { supported: true }, messaging: FULL_MESSAGING_CAPABILITY }).left)
            .toBe('capabilities.crdt must report supported, transports and apiBaseUrlConfigured');
    });
});
