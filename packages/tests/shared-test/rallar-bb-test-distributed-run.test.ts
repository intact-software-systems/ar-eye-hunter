import { describe, expect, it } from 'vitest';
import { validateDistributedRunManifestContract } from '../../shared-test/rallar-bb-test/distributed-run-validation.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES,
    type RallarBlackBoxControlAgentCandidate,
    type RallarBlackBoxDistributedRunManifest,
    type RallarBlackBoxDistributedRunManifestFields
} from '../../shared-test/rallar-bb-test/distributed-run.ts';
import {
    isDistributedRunTerminalState,
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES,
    rollupDistributedRunResult
} from '../../shared-test/rallar-bb-test/distributed/distributed-run-rollup.ts';
import { resolveDistributedRunTargets } from '../../shared-test/rallar-bb-test/distributed/resolve-distributed-run-targets.ts';
import {
    decodeDistributedRunManifest,
    toDistributedRunManifestValidationText,
    validateDistributedRunManifest
} from '../../shared-test/rallar-bb-test/mod.ts';
import { RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { formatJsonSchemaValidationErrors, validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';

function validManifest(
    overrides: Partial<RallarBlackBoxDistributedRunManifestFields> = {}
): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'distributed-contract-run',
        controlRunId: 'control-run-1',
        displayName: 'Distributed contract smoke',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group'
        },
        recipes: [
            {
                recipeId: 'health-only',
                role: 'all-agents',
                required: true,
                variables: {
                    payload: {
                        text: 'hello'
                    }
                },
                secretRefs: []
            }
        ],
        targetPolicy: {
            mode: 'selected-agents',
            expectedParticipantCount: 2,
            agentIds: ['alice-agent', 'bob-agent'],
            includeOfflineExpectedAgents: false
        },
        variables: {
            apiBaseUrl: 'http://localhost:8080'
        },
        secretRefs: ['accessToken'],
        roleAssignments: [
            {
                role: 'sender',
                agentId: 'alice-agent',
                recipeIds: ['health-only'],
                required: true,
                variables: {}
            },
            {
                role: 'receiver',
                agentId: 'bob-agent',
                recipeIds: ['health-only'],
                required: true,
                variables: {}
            }
        ],
        ackTimeoutMs: 5_000,
        barrier: { enabled: false },
        startMode: 'manual',
        artifactPolicy: {
            retainArtifacts: true,
            includeEventJsonl: true,
            includeResultJsonl: true,
            includeFailureBundle: true,
            includeDistributedMetadata: true,
            retentionDays: 7
        },
        groupAssertions: [],
        metadata: {},
        ...overrides
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
    }> = {}
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
            sessionLabel: 'agent-session',
            updatedAtEpochMs: 1_000
        }
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
            'timed-out'
        ]);
        expect(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES).toEqual([
            'passed',
            'failed',
            'cancelled',
            'timed-out'
        ]);
        expect(isDistributedRunTerminalState('passed')).toBe(true);
        expect(isDistributedRunTerminalState('running')).toBe(false);
    });

    it('validates a complete manifest as JSON and domain contract', () => {
        const manifest = validManifest();
        const schemaResult = validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, manifest);
        expect(
            schemaResult.ok,
            schemaResult.ok ? undefined : formatJsonSchemaValidationErrors(schemaResult.errors)
        ).toBe(true);

        expect(validateDistributedRunManifestContract(manifest)).toEqual([]);
    });

    it('decodes JSON through the schema before the domain contract', () => {
        const valid = decodeDistributedRunManifest(validManifest());
        const schemaInvalid = decodeDistributedRunManifest({
            ...validManifest(),
            schemaVersion: 2
        });
        const contractInvalid = decodeDistributedRunManifest(validManifest({
            distributedRunId: '   '
        }));

        expect(valid.right).toEqual(validManifest());
        expect(schemaInvalid.left).toEqual([expect.objectContaining({
            source: 'schema',
            path: '$.schemaVersion'
        })]);
        expect(contractInvalid.left).toEqual([{
            source: 'contract',
            path: '$.distributedRunId',
            message: 'A non-empty string is required.'
        }]);
        expect(toDistributedRunManifestValidationText(contractInvalid.left ?? [])).toBe(
            '$.distributedRunId: A non-empty string is required.'
        );
        expect(validateDistributedRunManifest(validManifest({ distributedRunId: '   ' })))
            .toEqual(contractInvalid.left);
    });

    it('accepts ordered target role policy for global fleet manifests', () => {
        const manifest = validManifest({
            targetPolicy: {
                mode: 'all-online-group-members',
                expectedParticipantCount: 50,
                includeOfflineExpectedAgents: false
            },
            roleAssignments: [],
            roleAssignmentPolicy: {
                mode: 'ordered-targets',
                pattern: 'one-sender-many-receivers',
                orderBy: 'agent-id'
            }
        });

        const schemaResult = validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, manifest);
        expect(
            schemaResult.ok,
            schemaResult.ok ? undefined : formatJsonSchemaValidationErrors(schemaResult.errors)
        ).toBe(true);

        expect(validateDistributedRunManifestContract(manifest)).toEqual([]);
    });

    it('rejects manifests that cannot be orchestrated independently of SPA state', () => {
        const manifest = validManifest({
            distributedRunId: '',
            recipes: [{
                recipeId: ' ',
                role: 'sender',
                variables: {},
                secretRefs: [],
                required: true
            }],
            targetPolicy: {
                mode: 'selected-agents',
                expectedParticipantCount: 0,
                agentIds: [],
                includeOfflineExpectedAgents: false
            },
            ackTimeoutMs: 0,
            barrier: {
                enabled: true,
                timeoutMs: 0
            }
        });

        expect(validateDistributedRunManifestContract(manifest).map((error) => error.path)).toEqual([
            '$.distributedRunId',
            '$.recipes[0].recipeId',
            '$.targetPolicy.expectedParticipantCount',
            '$.targetPolicy.agentIds',
            '$.ackTimeoutMs',
            '$.barrier.timeoutMs'
        ]);
    });

    it('requires role-map targets and scheduled start deadlines when requested', () => {
        const manifest = validManifest({
            targetPolicy: {
                mode: 'role-map',
                expectedParticipantCount: 2,
                roles: {},
                includeOfflineExpectedAgents: false
            },
            roleAssignments: []
        });

        expect(toManifestIssueTexts({ ...toValueWithoutKey(manifest, 'startMode'), startMode: 'scheduled' })).toEqual([
            '$.targetPolicy.roles role-map target policy requires roles or roleAssignments.',
            '$.startDeadlineEpochMs Scheduled distributed runs require startDeadlineEpochMs.'
        ]);
    });

    it('does not treat dynamic role assignment policy as role-map targets', () => {
        const issues = validateDistributedRunManifestContract(validManifest({
            targetPolicy: {
                mode: 'role-map',
                expectedParticipantCount: 2,
                roles: {},
                includeOfflineExpectedAgents: false
            },
            roleAssignments: [],
            roleAssignmentPolicy: {
                mode: 'ordered-targets',
                pattern: 'one-sender-many-receivers',
                orderBy: 'agent-id'
            }
        }));

        expect(issues.map((error) => error.path)).toContain('$.targetPolicy.roles');
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
                lastHeartbeatAtEpochMs: 9_900
            }
        ];

        const resolution = resolveDistributedRunTargets({
            manifest: validManifest({
                targetPolicy: {
                    mode: 'all-online-group-members',
                    expectedParticipantCount: 3,
                    includeOfflineExpectedAgents: false
                },
                roleAssignments: [],
                roleAssignmentPolicy: {
                    mode: 'ordered-targets',
                    pattern: 'one-sender-many-receivers',
                    orderBy: 'agent-id'
                }
            }),
            agents,
            nowEpochMs: 10_000,
            staleAfterMs: 1_000
        });

        expect(resolution.targetAgentIds).toEqual(['agent-01', 'agent-02', 'agent-03']);
        expect(resolution.roleAssignments).toEqual([
            { role: 'sender', agentId: 'agent-01', recipeIds: [], required: true, variables: {} },
            { role: 'receiver', agentId: 'agent-02', recipeIds: [], required: true, variables: {} },
            { role: 'receiver', agentId: 'agent-03', recipeIds: [], required: true, variables: {} }
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
            assertionCapabilityBlockedAgents: 0,
            agentsWithoutIdentity: 1,
            roleCounts: {
                sender: 1,
                receiver: 2
            },
            regions: {
                'eu-north': 1,
                'us-east': 1
            },
            providers: {
                fly: 1,
                hetzner: 1
            }
        });
        expect(resolution.blockers.map((blocker) => [blocker.agentId, blocker.status])).toEqual([
            ['stale-agent', 'stale-agent'],
            ['offline-agent', 'offline-agent'],
            ['wrong-group', 'different-group'],
            ['missing-identity', 'agent-without-identity']
        ]);
    });

    it('rolls participant readiness and recipe results into one distributed state', () => {
        expect(rollupDistributedRunResult({
            participants: [
                { agentId: 'alice-agent', state: 'ready', roles: [] },
                { agentId: 'bob-agent', state: 'ready', roles: [] }
            ]
        })).toMatchObject({
            state: 'ready',
            ok: false,
            summary: {
                readyParticipants: 2,
                blockingFailures: 0
            }
        });

        expect(
            rollupDistributedRunResult({
                participants: [
                    { agentId: 'alice-agent', state: 'running', roles: [] },
                    { agentId: 'bob-agent', state: 'ready', roles: [] }
                ],
                recipes: [
                    { recipeKey: 'alice:health', agentId: 'alice-agent', recipeId: 'health-only', state: 'running' }
                ]
            }).state
        ).toBe('running');

        expect(rollupDistributedRunResult({
            participants: [
                { agentId: 'alice-agent', state: 'passed', roles: [] },
                { agentId: 'bob-agent', state: 'passed', roles: [] }
            ],
            recipes: [
                { recipeKey: 'alice:health', agentId: 'alice-agent', recipeId: 'health-only', state: 'passed' },
                { recipeKey: 'bob:health', agentId: 'bob-agent', recipeId: 'health-only', state: 'passed' }
            ]
        })).toMatchObject({
            state: 'passed',
            ok: true,
            summary: {
                passedRecipes: 2,
                blockingFailures: 0
            }
        });
    });

    it('rolls every participant and recipe failure, timeout, and cancellation into the distributed state', () => {
        const participantFailure = rollupDistributedRunResult({
            participants: [
                { agentId: 'alice-agent', state: 'passed', roles: [] },
                { agentId: 'observer-agent', state: 'failed', roles: [] }
            ],
            recipes: [
                { recipeKey: 'alice:health', agentId: 'alice-agent', recipeId: 'health-only', state: 'passed' }
            ]
        });
        expect(participantFailure.state).toBe('failed');
        expect(participantFailure.summary.blockingFailures).toBe(1);

        const requiredFailure = rollupDistributedRunResult({
            recipes: [
                {
                    recipeKey: 'bob:health',
                    agentId: 'bob-agent',
                    recipeId: 'health-only',
                    state: 'failed',
                    error: {
                        code: 'recipe-failed',
                        message: 'Health recipe failed.'
                    }
                }
            ]
        });
        expect(requiredFailure.state).toBe('failed');
        expect(requiredFailure.failures[0]).toMatchObject({
            kind: 'recipe',
            key: 'bob:health',
            required: true,
            error: {
                code: 'recipe-failed'
            }
        });

        expect(
            rollupDistributedRunResult({
                participants: [{ agentId: 'alice-agent', state: 'timed-out', roles: [] }]
            }).state
        ).toBe('timed-out');

        expect(
            rollupDistributedRunResult({
                stateHint: 'waiting-for-barrier',
                participants: [
                    { agentId: 'alice-agent', state: 'acknowledged', roles: [] },
                    { agentId: 'bob-agent', state: 'acknowledged', roles: [] }
                ]
            }).state
        ).toBe('waiting-for-barrier');

        expect(
            rollupDistributedRunResult({
                stateHint: 'cancelled',
                participants: [{ agentId: 'alice-agent', state: 'running', roles: [] }]
            }).state
        ).toBe('cancelled');
    });

    it('validates groupAssertions against recipe keys, roles, and aggregate bounds', () => {
        const groupAssertionManifest = validManifest({
            groupAssertions: [
                {
                    groupAssertionId: 'members-agree',
                    aggregate: 'allEqual',
                    source: { recipeId: 'health-only', commandId: 'health-1', path: 'value.ok' },
                    scope: { role: 'receiver' },
                    minParticipants: 1
                },
                {
                    groupAssertionId: 'delivery-quorum',
                    aggregate: 'countMatching',
                    source: { recipeId: 'health-only', commandId: 'health-1', path: 'value.ok' },
                    predicate: { operator: 'equals', expected: true },
                    count: { gte: 1 }
                }
            ]
        });
        expect(validateDistributedRunManifestContract(groupAssertionManifest)).toEqual([]);

        const invalid = validateDistributedRunManifestContract(validManifest({
            recipes: [
                {
                    recipeId: 'inline-probe',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'inline-probe',
                        commands: [{ kind: 'health', commandId: 'probe-health' }]
                    },
                    variables: {},
                    secretRefs: [],
                    required: true
                }
            ],
            groupAssertions: [
                {
                    groupAssertionId: 'dup',
                    aggregate: 'allEqual',
                    source: { recipeId: 'unknown-recipe', commandId: 'x', path: 'value' }
                },
                {
                    groupAssertionId: 'dup',
                    aggregate: 'allEqual',
                    source: { recipeId: 'inline-probe', commandId: 'not-authored', path: 'value' },
                    scope: { role: 'ghost-role' }
                },
                {
                    groupAssertionId: 'bad-bounds',
                    aggregate: 'countMatching',
                    source: { recipeId: 'inline-probe', commandId: 'probe-health', path: 'value' },
                    predicate: { operator: 'exists' },
                    count: {},
                    minParticipants: 0
                },
                {
                    groupAssertionId: 'bad-tolerance',
                    aggregate: 'allEqualWithin',
                    source: { recipeId: 'inline-probe', commandId: 'probe-health', path: 'value' },
                    tolerance: -1
                }
            ]
        }));
        expect(invalid.map((error) => error.path)).toEqual(expect.arrayContaining([
            '$.groupAssertions[0].source.recipeId',
            '$.groupAssertions[1].groupAssertionId',
            '$.groupAssertions[1].source.commandId',
            '$.groupAssertions[1].scope.role',
            '$.groupAssertions[2].count',
            '$.groupAssertions[2].minParticipants',
            '$.groupAssertions[3].tolerance'
        ]));
    });

    it('rolls failed group assertions into blocking failures and summary counts', () => {
        const rollup = rollupDistributedRunResult({
            participants: [
                { agentId: 'alice-agent', state: 'passed', roles: [] },
                { agentId: 'bob-agent', state: 'passed', roles: [] }
            ],
            recipes: [
                { recipeKey: 'alice:health', agentId: 'alice-agent', state: 'passed' },
                { recipeKey: 'bob:health', agentId: 'bob-agent', state: 'passed' }
            ],
            groupAssertions: [
                {
                    groupAssertionId: 'members-agree',
                    aggregate: 'allEqual',
                    ok: false,
                    participants: { expected: 2, required: 2, withEvidence: 2 },
                    missingAgentIds: [],
                    violatingAgentIds: ['bob-agent'],
                    perAgent: [],
                    error: {
                        code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
                        message: 'Group assertion members-agree failed.'
                    }
                },
                {
                    groupAssertionId: 'no-leaks',
                    aggregate: 'noneMatch',
                    ok: true,
                    participants: { expected: 2, required: 2, withEvidence: 2, matching: 0 },
                    missingAgentIds: [],
                    violatingAgentIds: [],
                    perAgent: []
                }
            ]
        });

        expect(rollup.state).toBe('failed');
        expect(rollup.ok).toBe(false);
        expect(rollup.summary.groupAssertions).toBe(2);
        expect(rollup.summary.passedGroupAssertions).toBe(1);
        expect(rollup.summary.failedGroupAssertions).toBe(1);
        expect(rollup.failures).toEqual([
            {
                kind: 'group-assertion',
                key: 'members-agree',
                state: 'failed',
                required: true,
                error: {
                    code: 'RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED',
                    message: 'Group assertion members-agree failed.'
                }
            }
        ]);

        const passing = rollupDistributedRunResult({
            recipes: [{ recipeKey: 'alice:health', agentId: 'alice-agent', state: 'passed' }],
            groupAssertions: [{
                groupAssertionId: 'members-agree',
                aggregate: 'allEqual',
                ok: true,
                participants: { expected: 1, required: 1, withEvidence: 1 },
                missingAgentIds: [],
                violatingAgentIds: [],
                perAgent: []
            }]
        });
        expect(passing.state).toBe('passed');
        expect(passing.summary.failedGroupAssertions).toBe(0);
    });
});

function createExplicitManifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'explicit-run',
        controlRunId: 'explicit-control-run',
        group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'bb-group' },
        recipes: [{ recipeId: 'health-only', variables: {}, secretRefs: [], required: true }],
        targetPolicy: { mode: 'selected-agents', agentIds: ['alice-agent'], includeOfflineExpectedAgents: false },
        variables: {},
        secretRefs: [],
        roleAssignments: [{
            role: 'sender',
            agentId: 'alice-agent',
            recipeIds: [],
            required: true,
            variables: {}
        }],
        ackTimeoutMs: 5_000,
        barrier: { enabled: true, timeoutMs: 5_000 },
        startMode: 'manual',
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

function toValueWithoutKey<Value extends object>(value: Value, key: string): object {
    return Object.fromEntries(Object.entries(value).filter(([entryKey]) => entryKey !== key));
}

function toManifestIssueTexts(value: object): readonly string[] {
    return (decodeDistributedRunManifest(value).left ?? []).map((error) => `${error.path} ${error.message}`);
}

describe('distributed run manifest author settings', () => {
    it('accepts a manifest that writes every author setting explicitly', () => {
        expect(validateDistributedRunManifest(createExplicitManifest())).toEqual([]);
    });

    it.each([
        'schemaVersion',
        'controlRunId',
        'variables',
        'secretRefs',
        'roleAssignments',
        'ackTimeoutMs',
        'barrier',
        'startMode',
        'artifactPolicy',
        'groupAssertions',
        'metadata'
    ])('rejects a manifest without %s', (key) => {
        expect(toManifestIssueTexts(toValueWithoutKey(createExplicitManifest(), key))).toEqual([
            `$ Missing required property ${key}.`
        ]);
    });

    it.each(['recipeId', 'variables', 'secretRefs', 'required'])('rejects a recipe selection without %s', (key) => {
        const manifest = createExplicitManifest();
        expect(toManifestIssueTexts({ ...manifest, recipes: [toValueWithoutKey(manifest.recipes[0]!, key)] })).toEqual([
            `$.recipes[0] Missing required property ${key}.`
        ]);
    });

    it.each(['recipeIds', 'required', 'variables'])('rejects a role assignment without %s', (key) => {
        const manifest = createExplicitManifest();
        expect(
            toManifestIssueTexts({ ...manifest, roleAssignments: [toValueWithoutKey(manifest.roleAssignments[0]!, key)] })
        ).toEqual([`$.roleAssignments[0] Missing required property ${key}.`]);
    });

    it('rejects a target policy without includeOfflineExpectedAgents', () => {
        const manifest = createExplicitManifest();
        expect(
            toManifestIssueTexts({ ...manifest, targetPolicy: toValueWithoutKey(manifest.targetPolicy, 'includeOfflineExpectedAgents') })
        ).toEqual(['$.targetPolicy Missing required property includeOfflineExpectedAgents.']);
    });

    it('rejects a role assignment policy without orderBy', () => {
        expect(toManifestIssueTexts({
            ...createExplicitManifest(),
            roleAssignmentPolicy: { mode: 'ordered-targets', pattern: 'sender-receiver' }
        })).toEqual(['$.roleAssignmentPolicy Missing required property orderBy.']);
    });

    it.each([
        'retainArtifacts',
        'includeEventJsonl',
        'includeResultJsonl',
        'includeFailureBundle',
        'includeDistributedMetadata'
    ])('rejects an artifact policy without %s', (key) => {
        const manifest = createExplicitManifest();
        expect(toManifestIssueTexts({ ...manifest, artifactPolicy: toValueWithoutKey(manifest.artifactPolicy, key) }))
            .toEqual([`$.artifactPolicy Missing required property ${key}.`]);
    });

    it('rejects a barrier without enabled, an enabled barrier without timeoutMs and a disabled barrier with one', () => {
        expect(toManifestIssueTexts({ ...createExplicitManifest(), barrier: { timeoutMs: 5_000 } }))
            .toEqual(['$.barrier Missing required property enabled.']);
        expect(toManifestIssueTexts({ ...createExplicitManifest(), barrier: { enabled: true } }))
            .toEqual(['$.barrier.timeoutMs An enabled barrier requires timeoutMs.']);
        expect(toManifestIssueTexts({ ...createExplicitManifest(), barrier: { enabled: false, timeoutMs: 5_000 } }))
            .toEqual(['$.barrier.timeoutMs A disabled barrier accepts no timeoutMs.']);
    });

    it('accepts startDeadlineEpochMs only on scheduled runs', () => {
        expect(toManifestIssueTexts({ ...createExplicitManifest(), startDeadlineEpochMs: 20_000 }))
            .toEqual(['$.startDeadlineEpochMs Only scheduled distributed runs accept startDeadlineEpochMs.']);
        expect(toManifestIssueTexts({ ...createExplicitManifest(), startMode: 'scheduled', startDeadlineEpochMs: 20_000 }))
            .toEqual([]);
    });

    it('accepts agentIds only on selected-agents policies and roles only on role-map policies', () => {
        expect(toManifestIssueTexts({
            ...createExplicitManifest(),
            targetPolicy: { mode: 'all-online-group-members', agentIds: ['alice-agent'], includeOfflineExpectedAgents: false }
        })).toEqual(['$.targetPolicy.agentIds Only selected-agents target policies accept agentIds.']);
        expect(toManifestIssueTexts({
            ...createExplicitManifest(),
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: ['alice-agent'],
                roles: { sender: ['alice-agent'] },
                includeOfflineExpectedAgents: false
            }
        })).toEqual(['$.targetPolicy.roles Only role-map target policies accept roles.']);
        expect(toManifestIssueTexts({
            ...createExplicitManifest(),
            targetPolicy: { mode: 'selected-agents', includeOfflineExpectedAgents: false }
        })).toEqual(['$.targetPolicy.agentIds selected-agents target policy requires at least one agent ID.']);
        expect(toManifestIssueTexts({
            ...createExplicitManifest(),
            targetPolicy: { mode: 'role-map', includeOfflineExpectedAgents: false }
        })).toEqual(['$.targetPolicy.roles A role-map target policy requires roles.']);
    });
});
