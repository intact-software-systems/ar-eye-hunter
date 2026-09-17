import { describe, expect, it } from 'vitest';
import type {
    RallarBlackBoxControlAgentCandidate,
    RallarBlackBoxControlAgentCapabilities,
    RallarBlackBoxDistributedRunManifest
} from '../../shared-test/rallar-bb-test/distributed-run.ts';
import {
    computeDistributedAssertionFeatures,
    decodeControlAgentCapabilities,
    toControlAgentCapabilities,
    validateAgentAssertionCapability
} from '../../shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts';
import {
    resolveDistributedRunTargets
} from '../../shared-test/rallar-bb-test/distributed/resolve-distributed-run-targets.ts';
import type { RallarBlackBoxTestRecipe } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

const FULL_MESSAGING_CAPABILITY: RallarBlackBoxControlAgentCapabilities['messaging'] = {
    supported: true,
    carriers: ['ws', 'rtc', 'rtc-with-ws-fallback'],
    faults: true,
    storageCounters: true,
    reload: true
};

const BASELINE_ONLY_CAPABILITIES: RallarBlackBoxControlAgentCapabilities = {
    crdt: { supported: true, transports: [], apiBaseUrlConfigured: false },
    assertions: { absence: false, untilLoop: false, operators: ['equals', 'notEquals', 'contains', 'exists', 'gte', 'lte'] },
    messaging: FULL_MESSAGING_CAPABILITY
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
                recipe,
                variables: {}
            }
        ],
        targetPolicy: {
            mode: 'all-online-group-members',
            expectedParticipantCount: 1
        },
        startMode: 'manual',
        schemaVersion: 1,
        controlRunId: `gate-${recipe.recipeId}`,
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
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
            updatedAtEpochMs: 1_000,
            sessionLabel: 'gate-principal:gate-session'
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

    it('blocks staging targets for agents that advertise none of the required assertion features', () => {
        const resolution = resolveDistributedRunTargets({
            manifest: manifestWith(NEW_FEATURE_RECIPE),
            agents: [agentWith(BASELINE_ONLY_CAPABILITIES)],
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
            agents: [agentWith(BASELINE_ONLY_CAPABILITIES)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(baseline.targetAgentIds).toEqual(['gate-agent']);
        expect(baseline.blockers).toEqual([]);
    });

    it.each([
        {
            name: 'no assertions block',
            patch: { assertions: undefined },
            error: 'capabilities.assertions must report absence, untilLoop and operators'
        },
        {
            name: 'an assertions block without operators',
            patch: { assertions: { absence: true, untilLoop: true } },
            error: 'capabilities.assertions must report absence, untilLoop and operators'
        },
        {
            name: 'an operator the build does not know',
            patch: { assertions: { absence: true, untilLoop: true, operators: ['equals', 'resembles'] } },
            error: 'capabilities.assertions.operators must list known assert operators'
        },
        {
            name: 'a CRDT transport the build does not know',
            patch: { crdt: { supported: true, transports: ['ws', 'carrier-pigeon'], apiBaseUrlConfigured: true } },
            error: 'capabilities.crdt.transports must list known CRDT transports'
        },
        {
            name: 'a blank CRDT runtime surface',
            patch: { crdt: { supported: true, transports: ['ws'], runtimeSurface: ' ', apiBaseUrlConfigured: true } },
            error: 'capabilities.crdt.runtimeSurface must be a non-empty string when present'
        }
    ])('rejects a capability block with $name instead of reading it as absent', ({ patch, error }) => {
        const advertised = JSON.parse(JSON.stringify(toControlAgentCapabilities({
            config: undefined,
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080'
        })));

        expect(decodeControlAgentCapabilities({ ...advertised, ...patch }).left).toBe(error);
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

        expect(decodeControlAgentCapabilities({ crdt: { supported: true }, messaging: FULL_MESSAGING_CAPABILITY }).left)
            .toBe('capabilities.crdt must report supported, transports and apiBaseUrlConfigured');
    });
});
