import {
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlClientEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlRunSnapshotBounds } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { BuildDistributedRunManifestStart } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/build-distributed-run-manifest.ts';
import type {
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunManifestFields
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRedactionOptions
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { assert } from '@std/assert';

import type {
    CreateRallarBlackBoxControlServiceInput,
    RallarBlackBoxControlService
} from '../../src/control-service.ts';

export interface ControlServiceInputOverrides {
    readonly now?: () => number;
    readonly createCommandId?: () => string;
    readonly redaction?: RallarBlackBoxTestRedactionOptions;
    readonly allowedCommandKinds?: readonly string[];
    readonly commandRateLimitMax?: number;
    readonly commandRateLimitWindowMs?: number;
    readonly runtimeRetentionBounds?: ControlRunSnapshotBounds;
}

interface ControlRegisterFixtureInput {
    readonly runId?: string;
    readonly agentId?: string;
    readonly completedCommandIds?: readonly string[];
    readonly identity?: RallarBlackBoxControlAgentIdentity;
}

interface ControlResultFixtureInput {
    readonly runId: string;
    readonly agentId: string;
    readonly command: Readonly<{ commandId: string; command: RallarBlackBoxTestCommand; }>;
    readonly ok: boolean;
}

const RECIPE_RUN_RESULT_VALUE = {
    recipeId: 'health-only',
    results: [
        {
            commandId: 'health-child',
            kind: 'health',
            status: 'ok',
            ok: true,
            startedAtEpochMs: 2_001,
            endedAtEpochMs: 2_002,
            durationMs: 1
        }
    ]
};

const PRODUCTION_RUNTIME_RETENTION_BOUNDS: ControlRunSnapshotBounds = {
    commands: 1_000,
    results: 1_000,
    events: 2_000,
    stats: 500,
    reports: 20,
    heartbeats: 500
};

export function toControlServiceInput(
    overrides: ControlServiceInputOverrides = {}
): CreateRallarBlackBoxControlServiceInput {
    return {
        dependencies: {
            now: overrides.now ?? (() => Date.now()),
            createCommandId: overrides.createCommandId ?? (() => crypto.randomUUID())
        },
        config: {
            redaction: overrides.redaction,
            allowedCommandKinds: overrides.allowedCommandKinds,
            commandRateLimitMax: overrides.commandRateLimitMax ?? 120,
            commandRateLimitWindowMs: overrides.commandRateLimitWindowMs ?? 60_000,
            runtimeRetentionBounds: overrides.runtimeRetentionBounds ?? PRODUCTION_RUNTIME_RETENTION_BOUNDS
        }
    };
}

// Compares serialized JSON, so absent and undefined fields are equal and key order matters.
export function assertJsonEquals<TValue>(actual: TValue, expected: TValue): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`
        );
    }
}

export function assertRight<TFailure, TValue>(result: Either<TFailure, TValue>): TValue {
    assert(result.right !== undefined, `Expected success, got ${JSON.stringify(result.left)}.`);
    return result.right;
}

export function toConfigureCommand(): RallarBlackBoxTestCommand {
    return {
        kind: 'configure',
        config: {
            runId: 'run-1',
            agentId: 'agent-1',
            actor: 'alice'
        }
    };
}
export function toRegisterEnvelope(
    { runId = 'run-1', agentId = 'agent-1', completedCommandIds = [], identity }: ControlRegisterFixtureInput = {}
): ControlClientEnvelope {
    return {
        kind: 'register',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId,
        agentId,
        atEpochMs: 1_000,
        identity,
        resume: {
            completedCommandIds
        }
    };
}
export function toCommandResultEnvelope(
    { runId, agentId, command, ok }: ControlResultFixtureInput
): ControlClientEnvelope {
    return {
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId,
        agentId,
        commandId: command.commandId,
        ok,
        result: {
            commandId: command.commandId,
            kind: command.command.kind,
            status: ok ? 'ok' : 'failed',
            ok,
            startedAtEpochMs: 2_000,
            endedAtEpochMs: 2_010,
            durationMs: 10,
            value: command.command.kind === 'recipe.run' ? RECIPE_RUN_RESULT_VALUE : { ok },
            error: ok ? undefined : { code: 'TEST_FAILURE', message: 'Simulated failure.' }
        }
    };
}
export function toDistributedManifest(
    overrides: Partial<RallarBlackBoxDistributedRunManifestFields> = {},
    start: BuildDistributedRunManifestStart = { startMode: 'manual' }
): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'dist-1',
        controlRunId: 'run-1',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group'
        },
        recipes: [
            {
                recipeId: 'health-only',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'health-only',
                    commands: [
                        {
                            kind: 'health',
                            commandId: 'health-child'
                        }
                    ]
                },
                variables: {},
                secretRefs: [],
                required: true
            }
        ],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1', 'agent-2'],
            includeOfflineExpectedAgents: false
        },
        variables: {},
        secretRefs: [],
        roleAssignments: [],
        ackTimeoutMs: 1_000,
        barrier: { enabled: false },
        artifactPolicy: {
            retainArtifacts: true,
            includeEventJsonl: true,
            includeResultJsonl: true,
            includeFailureBundle: true,
            includeDistributedMetadata: true
        },
        groupAssertions: [],
        metadata: {},
        ...overrides,
        ...start
    };
}
export function toFleetIdentity(
    agentId: string,
    overrides: Partial<RallarBlackBoxControlAgentIdentity> = {}
): RallarBlackBoxControlAgentIdentity {
    return {
        principalId: agentId,
        clientId: agentId,
        sessionId: `${agentId}-session`,
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'bb-group',
        sessionLabel: `${agentId}:${agentId}-session`,
        updatedAtEpochMs: 1_000,
        ...overrides
    };
}
export function registerFleetAgents(
    service: RallarBlackBoxControlService,
    count: number
): void {
    for (let index = 1; index <= count; index += 1) {
        const agentId = `agent-${String(index).padStart(2, '0')}`;
        service.receiveClientEnvelope(
            toRegisterEnvelope({
                runId: 'run-1',
                agentId: agentId,
                completedCommandIds: [],
                identity: toFleetIdentity(agentId, {
                    region: index <= Math.ceil(count / 2) ? 'eu-north' : 'us-east',
                    provider: index % 2 === 0 ? 'fly' : 'hetzner'
                })
            })
        );
    }
}
export function toPrincipalWorldFleetManifest(
    expectedParticipantCount: number
): RallarBlackBoxDistributedRunManifest {
    return toDistributedManifest({
        recipes: [
            {
                recipeId: 'sender-recipe',
                role: 'sender',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'sender-recipe',
                    commands: [{ kind: 'health', commandId: 'sender-health' }]
                },
                variables: {},
                secretRefs: [],
                required: true
            },
            {
                recipeId: 'receiver-recipe',
                role: 'receiver',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'receiver-recipe',
                    commands: [{ kind: 'health', commandId: 'receiver-health' }]
                },
                variables: {},
                secretRefs: [],
                required: true
            }
        ],
        targetPolicy: {
            mode: 'all-online-group-members',
            expectedParticipantCount,
            includeOfflineExpectedAgents: false
        },
        roleAssignmentPolicy: {
            mode: 'ordered-targets',
            pattern: 'one-sender-many-receivers',
            orderBy: 'agent-id'
        }
    });
}
