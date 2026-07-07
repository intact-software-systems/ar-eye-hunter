import { describe, expect, it } from 'vitest';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    formatJsonSchemaValidationErrors,
    validateJsonSchema,
} from '../../shared-test/rallar-bb-test/schema.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES,
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES,
    isDistributedRunTerminalState,
    resolveDistributedTargetAgentIds,
    resolveDistributedRunTargets,
    resolveGroupMemberControlAgentMatches,
    rollupDistributedRunResult,
    validateDistributedRunManifestContract,
    type RallarBlackBoxControlAgentCandidate,
    type RallarBlackBoxDistributedRunManifest,
} from '../../shared-test/rallar-bb-test/distributed-run.ts';

function validManifest(overrides: Partial<RallarBlackBoxDistributedRunManifest> = {}): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'distributed-contract-run',
        controlRunId: 'control-run-1',
        displayName: 'Distributed contract smoke',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group',
        },
        recipes: [
            {
                recipeId: 'health-only',
                role: 'all-agents',
                required: true,
                variables: {
                    payload: {
                        text: 'hello',
                    },
                },
            },
        ],
        targetPolicy: {
            mode: 'selected-agents',
            expectedParticipantCount: 2,
            agentIds: ['alice-agent', 'bob-agent'],
        },
        variables: {
            apiBaseUrl: 'http://localhost:8080',
        },
        secretRefs: ['accessToken'],
        roleAssignments: [
            {
                role: 'sender',
                agentId: 'alice-agent',
                recipeIds: ['health-only'],
                required: true,
            },
            {
                role: 'receiver',
                agentId: 'bob-agent',
                recipeIds: ['health-only'],
                required: true,
            },
        ],
        ackTimeoutMs: 5_000,
        startMode: 'manual',
        artifactPolicy: {
            retainArtifacts: true,
            includeEventJsonl: true,
            includeResultJsonl: true,
            includeFailureBundle: true,
            includeDistributedMetadata: true,
            retentionDays: 7,
        },
        ...overrides,
    };
}

function targetAgent(
    agentId: string,
    options: Readonly<{
        connected?: boolean;
        groupId?: string;
        lastHeartbeatAtEpochMs?: number;
        region?: string;
        provider?: string;
    }> = {},
): RallarBlackBoxControlAgentCandidate {
    return {
        agentId,
        connected: options.connected ?? true,
        lastHeartbeatAtEpochMs: options.lastHeartbeatAtEpochMs ?? 9_900,
        identity: {
            principalId: agentId,
            clientId: agentId,
            username: agentId,
            sessionId: `${agentId}-session`,
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: options.groupId ?? 'bb-group',
            region: options.region,
            provider: options.provider,
        },
    };
}

describe('rallar-bb-test distributed run contract', () => {
    it('defines stable lifecycle and terminal states', () => {
        expect(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES).toEqual([
            'draft',
            'resolving-targets',
            'staging',
            'waiting-for-ack',
            'waiting-for-barrier',
            'ready',
            'running',
            'passed',
            'failed',
            'cancelled',
            'timed-out',
        ]);
        expect(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES).toEqual([
            'passed',
            'failed',
            'cancelled',
            'timed-out',
        ]);
        expect(isDistributedRunTerminalState('passed')).toBe(true);
        expect(isDistributedRunTerminalState('running')).toBe(false);
    });

    it('validates a complete manifest as JSON and domain contract', () => {
        const manifest = validManifest();
        const schemaResult = validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, manifest);
        expect(
            schemaResult.ok,
            schemaResult.ok ? undefined : formatJsonSchemaValidationErrors(schemaResult.errors),
        ).toBe(true);

        expect(validateDistributedRunManifestContract(manifest)).toEqual({
            ok: true,
            errors: [],
        });
    });

    it('accepts ordered target role policy for global fleet manifests', () => {
        const manifest = validManifest({
            targetPolicy: {
                mode: 'all-online-group-members',
                expectedParticipantCount: 50,
            },
            roleAssignments: undefined,
            roleAssignmentPolicy: {
                mode: 'ordered-targets',
                pattern: 'one-sender-many-receivers',
                orderBy: 'agent-id',
            },
        });

        const schemaResult = validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, manifest);
        expect(
            schemaResult.ok,
            schemaResult.ok ? undefined : formatJsonSchemaValidationErrors(schemaResult.errors),
        ).toBe(true);

        expect(validateDistributedRunManifestContract(manifest)).toEqual({
            ok: true,
            errors: [],
        });
    });

    it('rejects manifests that cannot be orchestrated independently of SPA state', () => {
        const manifest = validManifest({
            distributedRunId: '',
            recipes: [{ role: 'sender' }],
            targetPolicy: {
                mode: 'selected-agents',
                expectedParticipantCount: 0,
                agentIds: [],
            },
            ackTimeoutMs: 0,
            barrier: {
                enabled: true,
                timeoutMs: 0,
            },
        });

        const result = validateDistributedRunManifestContract(manifest);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors.map(error => error.path)).toEqual(expect.arrayContaining([
                '$.distributedRunId',
                '$.recipes[0]',
                '$.targetPolicy.expectedParticipantCount',
                '$.targetPolicy.agentIds',
                '$.ackTimeoutMs',
                '$.barrier.timeoutMs',
            ]));
        }
    });

    it('requires role-map targets and scheduled start deadlines when requested', () => {
        const result = validateDistributedRunManifestContract(validManifest({
            targetPolicy: {
                mode: 'role-map',
                expectedParticipantCount: 2,
            },
            roleAssignments: [],
            startMode: 'scheduled',
            startDeadlineEpochMs: undefined,
        }));

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors.map(error => error.path)).toEqual(expect.arrayContaining([
                '$.targetPolicy.roles',
                '$.startDeadlineEpochMs',
            ]));
        }
    });

    it('does not treat dynamic role assignment policy as role-map targets', () => {
        const result = validateDistributedRunManifestContract(validManifest({
            targetPolicy: {
                mode: 'role-map',
                expectedParticipantCount: 2,
            },
            roleAssignments: [],
            roleAssignmentPolicy: {
                mode: 'ordered-targets',
                pattern: 'one-sender-many-receivers',
                orderBy: 'agent-id',
            },
        }));

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errors.map(error => error.path)).toContain('$.targetPolicy.roles');
        }
    });

    it('correlates current group members with connected control-agent identity metadata', () => {
        const matchResult = resolveGroupMemberControlAgentMatches({
            nowEpochMs: 10_000,
            staleAfterMs: 1_000,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            members: [
                { principalId: 'alice', sessionIds: ['alice-session'], online: true },
                { principalId: 'bob', sessionIds: ['bob-session'], online: true },
                { principalId: 'charlie', sessionIds: ['charlie-session'], online: true },
                { principalId: 'dana', sessionIds: ['dana-session'], online: true },
            ],
            agents: [
                {
                    agentId: 'alice-agent',
                    connected: true,
                    lastHeartbeatAtEpochMs: 9_900,
                    identity: {
                        principalId: 'alice',
                        clientId: 'alice',
                        sessionId: 'alice-session',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group',
                    },
                },
                {
                    agentId: 'bob-agent-old',
                    connected: true,
                    lastHeartbeatAtEpochMs: 8_000,
                    identity: {
                        principalId: 'bob',
                        sessionId: 'bob-session',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group',
                    },
                },
                {
                    agentId: 'charlie-agent',
                    connected: false,
                    identity: {
                        principalId: 'charlie',
                        sessionId: 'charlie-session',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group',
                    },
                },
                {
                    agentId: 'dana-agent-1',
                    connected: true,
                    lastHeartbeatAtEpochMs: 9_950,
                    identity: {
                        principalId: 'dana',
                        sessionId: 'dana-session',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group',
                    },
                },
                {
                    agentId: 'dana-agent-2',
                    connected: true,
                    lastHeartbeatAtEpochMs: 9_960,
                    identity: {
                        principalId: 'dana',
                        sessionId: 'dana-session',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group',
                    },
                },
                {
                    agentId: 'unknown-agent',
                    connected: true,
                    lastHeartbeatAtEpochMs: 9_900,
                    identity: {
                        principalId: 'eve',
                        sessionId: 'eve-session',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group',
                    },
                },
                {
                    agentId: 'no-identity-agent',
                    connected: true,
                    lastHeartbeatAtEpochMs: 9_900,
                },
            ],
        });

        expect(matchResult.targetableAgentIds).toEqual(['alice-agent']);
        expect(matchResult.summary).toMatchObject({
            members: 4,
            agents: 7,
            matched: 1,
            staleAgents: 1,
            offlineAgents: 1,
            duplicateSessions: 1,
            agentsWithoutMembers: 1,
            agentsWithoutIdentity: 1,
        });
        expect(matchResult.matches.map(match => match.status)).toEqual([
            'matched',
            'stale-agent',
            'offline-agent',
            'duplicate-session',
            'agent-without-group-member',
            'agent-without-identity',
        ]);
    });

    it('resolves target policies through only targetable agent matches', () => {
        const matchResult = resolveGroupMemberControlAgentMatches({
            nowEpochMs: 10_000,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            members: [
                { principalId: 'alice', sessionIds: ['alice-session'] },
                { principalId: 'bob', sessionIds: ['bob-session'] },
            ],
            agents: [
                {
                    agentId: 'alice-agent',
                    connected: true,
                    lastHeartbeatAtEpochMs: 9_900,
                    identity: {
                        principalId: 'alice',
                        sessionId: 'alice-session',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group',
                    },
                },
                {
                    agentId: 'bob-agent',
                    connected: true,
                    lastHeartbeatAtEpochMs: 9_900,
                    identity: {
                        principalId: 'bob',
                        sessionId: 'bob-session',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group',
                    },
                },
                {
                    agentId: 'offline-agent',
                    connected: false,
                    identity: {
                        principalId: 'charlie',
                        sessionId: 'charlie-session',
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'bb-group',
                    },
                },
            ],
        });

        expect(resolveDistributedTargetAgentIds({
            matchResult,
            targetPolicy: { mode: 'all-online-group-members' },
        })).toEqual(['alice-agent', 'bob-agent']);
        expect(resolveDistributedTargetAgentIds({
            matchResult,
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: ['bob-agent', 'offline-agent'],
            },
        })).toEqual(['bob-agent']);
        expect(resolveDistributedTargetAgentIds({
            matchResult,
            targetPolicy: {
                mode: 'role-map',
                roles: {
                    sender: ['alice-agent'],
                    receiver: ['bob-agent', 'offline-agent'],
                },
            },
        })).toEqual(['alice-agent', 'bob-agent']);
    });

    it('resolves global fleet targets and derives deterministic sender receiver roles', () => {
        const agents: RallarBlackBoxControlAgentCandidate[] = [
            targetAgent('agent-03'),
            targetAgent('agent-01', { region: 'eu-north', provider: 'hetzner' }),
            targetAgent('agent-02', { region: 'us-east', provider: 'fly' }),
            targetAgent('stale-agent', { lastHeartbeatAtEpochMs: 1_000 }),
            targetAgent('offline-agent', { connected: false }),
            targetAgent('wrong-group', { groupId: 'other-group' }),
            {
                agentId: 'missing-identity',
                connected: true,
                lastHeartbeatAtEpochMs: 9_900,
            },
        ];

        const resolution = resolveDistributedRunTargets({
            manifest: validManifest({
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 3,
                },
                roleAssignments: undefined,
                roleAssignmentPolicy: {
                    mode: 'ordered-targets',
                    pattern: 'one-sender-many-receivers',
                    orderBy: 'agent-id',
                },
            }),
            agents,
            nowEpochMs: 10_000,
            staleAfterMs: 1_000,
        });

        expect(resolution.targetAgentIds).toEqual(['agent-01', 'agent-02', 'agent-03']);
        expect(resolution.roleAssignments).toEqual([
            { role: 'sender', agentId: 'agent-01', required: true },
            { role: 'receiver', agentId: 'agent-02', required: true },
            { role: 'receiver', agentId: 'agent-03', required: true },
        ]);
        expect(resolution.summary).toMatchObject({
            agents: 7,
            targetable: 3,
            selected: 3,
            expectedParticipantCount: 3,
            missingExpectedParticipants: 0,
            staleAgents: 1,
            offlineAgents: 1,
            wrongGroupAgents: 1,
            agentsWithoutIdentity: 1,
            roleCounts: {
                sender: 1,
                receiver: 2,
            },
            regions: {
                'eu-north': 1,
                'us-east': 1,
            },
            providers: {
                fly: 1,
                hetzner: 1,
            },
        });
        expect(resolution.blockers.map(blocker => [blocker.agentId, blocker.status])).toEqual([
            ['stale-agent', 'stale-agent'],
            ['offline-agent', 'offline-agent'],
            ['wrong-group', 'different-group'],
            ['missing-identity', 'agent-without-identity'],
        ]);
    });

    it('rolls participant readiness and recipe results into one distributed state', () => {
        expect(rollupDistributedRunResult({
            participants: [
                { agentId: 'alice-agent', state: 'ready', required: true },
                { agentId: 'bob-agent', state: 'ready', required: true },
            ],
        })).toMatchObject({
            state: 'ready',
            ok: false,
            summary: {
                readyParticipants: 2,
                blockingFailures: 0,
            },
        });

        expect(rollupDistributedRunResult({
            participants: [
                { agentId: 'alice-agent', state: 'running', required: true },
                { agentId: 'bob-agent', state: 'ready', required: true },
            ],
            recipes: [
                { recipeKey: 'alice:health', agentId: 'alice-agent', recipeId: 'health-only', state: 'running' },
            ],
        }).state).toBe('running');

        expect(rollupDistributedRunResult({
            participants: [
                { agentId: 'alice-agent', state: 'passed', required: true },
                { agentId: 'bob-agent', state: 'passed', required: true },
            ],
            recipes: [
                { recipeKey: 'alice:health', agentId: 'alice-agent', recipeId: 'health-only', state: 'passed' },
                { recipeKey: 'bob:health', agentId: 'bob-agent', recipeId: 'health-only', state: 'passed' },
            ],
        })).toMatchObject({
            state: 'passed',
            ok: true,
            summary: {
                passedRecipes: 2,
                blockingFailures: 0,
            },
        });
    });

    it('rolls required failures, timeouts, and cancellations before optional failures', () => {
        const optionalFailure = rollupDistributedRunResult({
            participants: [
                { agentId: 'alice-agent', state: 'passed', required: true },
                { agentId: 'observer-agent', state: 'failed', required: false },
            ],
            recipes: [
                { recipeKey: 'alice:health', agentId: 'alice-agent', recipeId: 'health-only', state: 'passed' },
            ],
        });
        expect(optionalFailure.state).toBe('passed');
        expect(optionalFailure.summary.blockingFailures).toBe(0);

        const requiredFailure = rollupDistributedRunResult({
            recipes: [
                {
                    recipeKey: 'bob:health',
                    agentId: 'bob-agent',
                    recipeId: 'health-only',
                    state: 'failed',
                    error: {
                        code: 'recipe-failed',
                        message: 'Health recipe failed.',
                    },
                },
            ],
        });
        expect(requiredFailure.state).toBe('failed');
        expect(requiredFailure.failures[0]).toMatchObject({
            kind: 'recipe',
            key: 'bob:health',
            required: true,
            error: {
                code: 'recipe-failed',
            },
        });

        expect(rollupDistributedRunResult({
            participants: [{ agentId: 'alice-agent', state: 'timed-out' }],
        }).state).toBe('timed-out');

        expect(rollupDistributedRunResult({
            stateHint: 'waiting-for-barrier',
            participants: [
                { agentId: 'alice-agent', state: 'acknowledged' },
                { agentId: 'bob-agent', state: 'acknowledged' },
            ],
        }).state).toBe('waiting-for-barrier');

        expect(rollupDistributedRunResult({
            stateHint: 'cancelled',
            participants: [{ agentId: 'alice-agent', state: 'running' }],
        }).state).toBe('cancelled');
    });
});
