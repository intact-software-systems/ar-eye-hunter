import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '../../../shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RallarBlackBoxControlAgentCandidate,
    RallarBlackBoxControlAgentCapabilities,
    RallarBlackBoxDistributedRunManifest
} from '../../../shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxGroupMemberCandidate
} from '../../../shared-test/rallar-bb-test/distributed/resolve-group-member-control-agent-matches.ts';

export const PRESERVATION_NOW_EPOCH_MS = 1_900_000_000_000;
export const PRESERVATION_STALE_AFTER_MS = 30_000;

const MANIFEST_ROOT = new URL('../../../../apps/rallar-black-box/manifests/', import.meta.url);
const MONITOR_AGENT_COUNT = 240;
const MONITOR_RECIPE_IDS = ['recipe:a|b', 'recipe:a:b', 'מתכון-界'];

type PreservationJsonValue = object | string | number | boolean | null | undefined;

export interface CommittedManifest {
    readonly path: string;
    readonly manifest: RallarBlackBoxDistributedRunManifest;
}

export interface MonitorPreservationInput {
    readonly distributedRun: ControlDistributedRunSnapshot;
    readonly controlRun: ControlRunSnapshot;
}

export function readCommittedManifests(): readonly CommittedManifest[] {
    return readdirSync(MANIFEST_ROOT, { recursive: true, encoding: 'utf8' })
        .filter((path) => path.endsWith('.json'))
        .sort()
        .map((path) => ({
            path,
            manifest: JSON.parse(readFileSync(new URL(path, MANIFEST_ROOT), 'utf8')) as RallarBlackBoxDistributedRunManifest
        }));
}

/** Explicit manifests that break one schema or contract rule each and read the same before and after B6b. */
export function toInvalidManifestVariants(manifest: RallarBlackBoxDistributedRunManifest): readonly object[] {
    return [
        { ...manifest, distributedRunId: ' ' },
        { ...manifest, group: { ...manifest.group, groupId: '' } },
        { ...manifest, recipes: [] },
        { ...manifest, targetPolicy: { ...manifest.targetPolicy, expectedParticipantCount: 0 } },
        { ...manifest, targetPolicy: { mode: 'selected-agents', agentIds: [], includeOfflineExpectedAgents: false } },
        { ...manifest, ackTimeoutMs: 0 },
        { ...manifest, barrier: { enabled: true, timeoutMs: 0 } },
        { ...manifest, roleAssignmentPolicy: { mode: 'ordered-targets', pattern: 'ring', orderBy: 'agentId' } },
        { ...manifest, unexpected: true },
        { ...manifest, groupAssertions: [...manifest.groupAssertions, ...manifest.groupAssertions] }
    ];
}

export function toManifestTargetAgents(
    manifest: RallarBlackBoxDistributedRunManifest
): readonly RallarBlackBoxControlAgentCandidate[] {
    const declared = manifest.targetPolicy.mode === 'selected-agents'
        ? manifest.targetPolicy.agentIds
        : manifest.targetPolicy.mode === 'role-map'
        ? Object.values(manifest.targetPolicy.roles).flat()
        : [];
    const agentIds = [...declared, ...Array.from({ length: 12 }, (_, index) => `fleet-agent-${index}`)];
    return agentIds.map((agentId, index) => toAgentCandidate(manifest, agentId, index));
}

export function toGroupMembers(
    agents: readonly RallarBlackBoxControlAgentCandidate[]
): readonly RallarBlackBoxGroupMemberCandidate[] {
    return [
        ...agents.map((agent, index) => ({
            principalId: `principal-${index}`,
            ...(index % 4 === 1 ? { username: `user-${index}` } : {}),
            sessionIds: index % 3 === 0 ? [] : [`session-${index}`]
        })),
        { principalId: 'principal-duplicate', sessionIds: [] },
        { principalId: 'principal-unmatched', username: 'nobody', sessionIds: ['session-none'] }
    ];
}

export function createMonitorPreservationInput(): MonitorPreservationInput {
    const distributedRunId = 'distributed:preservation|界';
    const controlRunId = 'control:preservation|界';
    const agentIds = Array.from({ length: MONITOR_AGENT_COUNT }, (_, index) => `agent-${String(index).padStart(3, '0')}`);
    const commandIds = agentIds.map((_, index) => `command-${String(index).padStart(3, '0')}`);
    const phases = ['stage', 'barrier', 'start', 'cancel'] as const;
    return {
        distributedRun: {
            distributedRunId,
            controlRunId,
            state: 'failed',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 30_000,
            stagedAtEpochMs: 2_000,
            startedAtEpochMs: 3_000,
            completedAtEpochMs: 30_000,
            targetAgentIds: agentIds,
            manifest: toMonitorManifest({ distributedRunId, controlRunId, agentIds }),
            commandLinks: commandIds.map((commandId, index) => ({
                phase: phases[index % phases.length]!,
                agentId: agentIds[index]!,
                commandId,
                ...(index % 17 === 0 ? {} : { recipeId: MONITOR_RECIPE_IDS[index % MONITOR_RECIPE_IDS.length]! }),
                ...(index % 5 === 0 ? { role: index % 10 === 0 ? 'sender' : 'receiver' } : {}),
                queuedAtEpochMs: 10_000 + index
            })),
            rollup: toMonitorRollup(agentIds)
        },
        controlRun: {
            runId: controlRunId,
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 30_000,
            agents: [],
            commands: commandIds.map((commandId, index) => ({
                envelope: {
                    kind: 'command',
                    protocolVersion: 1,
                    runId: controlRunId,
                    agentId: agentIds[index],
                    commandId,
                    command: { kind: 'health' }
                },
                queuedAtEpochMs: 10_000 + index,
                dispatchedAtEpochMs: index % 13 === 0 ? undefined : 10_100 + index,
                completedAtEpochMs: index % 19 === 0 ? undefined : 10_200 + index,
                dispatchCount: index % 13 === 0 ? 0 : 1
            })),
            results: commandIds.map((commandId, index) => toMonitorResult({ controlRunId, agentIds, commandId, index })),
            events: agentIds.map((agentId, index) => toMonitorEvent({ controlRunId, distributedRunId, agentId, commandId: commandIds[index]!, index })),
            stats: [],
            reports: [],
            heartbeats: []
        }
    };
}

export function toPreservationDigest(value: object): string {
    const text = JSON.stringify(value, toPreservationJsonValue);
    return `${createHash('sha256').update(text).digest('hex')}:${text.length}`;
}

function toPreservationJsonValue(_key: string, item: PreservationJsonValue): PreservationJsonValue {
    return item instanceof Map
        ? { entries: [...item.entries()] }
        : item instanceof Set
        ? { values: [...item.values()] }
        : item;
}

function toAgentCandidate(
    manifest: RallarBlackBoxDistributedRunManifest,
    agentId: string,
    index: number
): RallarBlackBoxControlAgentCandidate {
    if (index % 7 === 5) {
        return { agentId, connected: true, lastHeartbeatAtEpochMs: PRESERVATION_NOW_EPOCH_MS - 1_000 };
    }
    const groupId = index % 7 === 4 ? `${manifest.group.groupId}-other` : manifest.group.groupId;
    return {
        agentId,
        connected: index % 7 !== 3,
        lastHeartbeatAtEpochMs: PRESERVATION_NOW_EPOCH_MS - (index % 7 === 2 ? 60_000 : 1_000),
        identity: {
            principalId: index === 1 ? 'principal-duplicate' : `principal-${index}`,
            username: `user-${index}`,
            sessionId: `session-${index}`,
            applicationId: manifest.group.applicationId,
            workspaceId: manifest.group.workspaceId,
            groupId,
            region: index % 2 === 0 ? 'eu-central' : 'us-east',
            provider: 'hetzner',
            capabilities: toAgentCapabilities(index)
        }
    };
}

function toAgentCapabilities(index: number): RallarBlackBoxControlAgentCapabilities {
    return {
        crdt: { supported: true, transports: ['ws', 'rtc'], apiBaseUrlConfigured: true },
        ...(index % 7 === 1 ? {} : {
            assertions: {
                absence: index % 7 !== 6,
                untilLoop: true,
                operators: index % 7 === 6 ? ['equals'] : ['equals', 'notEquals', 'gt', 'lt', 'between', 'matches']
            }
        }),
        messaging: { supported: true, carriers: ['ws', 'rtc'], faults: true, storageCounters: true, reload: false }
    };
}

function toMonitorManifest(
    input: Readonly<{ distributedRunId: string; controlRunId: string; agentIds: readonly string[]; }>
): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: input.distributedRunId,
        controlRunId: input.controlRunId,
        displayName: 'Derived output preservation monitor',
        group: { applicationId: 'rallar-server', workspaceId: 'workspace:界', groupId: 'group|exact:界' },
        recipes: MONITOR_RECIPE_IDS.map((recipeId, index) => ({
            recipeId,
            ...(index === 1 ? { role: 'receiver' } : {}),
            required: index !== 2,
            variables: {},
            secretRefs: []
        })),
        targetPolicy: {
            mode: 'role-map',
            roles: { sender: input.agentIds.slice(0, 20), receiver: input.agentIds.slice(20, 120) },
            expectedParticipantCount: input.agentIds.length,
            includeOfflineExpectedAgents: false
        },
        variables: {},
        secretRefs: [],
        roleAssignments: input.agentIds.slice(120).map((agentId, index) => ({
            role: index % 2 === 0 ? 'receiver' : 'observer',
            agentId,
            recipeIds: index % 3 === 0 ? [MONITOR_RECIPE_IDS[0]!] : index % 3 === 1 ? [] : ['recipe:unknown'],
            required: index % 5 !== 0,
            variables: {}
        })),
        ackTimeoutMs: 30_000,
        barrier: { enabled: true, timeoutMs: 45_000 },
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

function toMonitorRollup(agentIds: readonly string[]): ControlDistributedRunSnapshot['rollup'] {
    return {
        state: 'failed',
        ok: false,
        summary: {
            participants: agentIds.length,
            requiredParticipants: agentIds.length,
            readyParticipants: 60,
            passedParticipants: agentIds.length - 3,
            failedParticipants: 3,
            recipes: MONITOR_RECIPE_IDS.length,
            requiredRecipes: 2,
            passedRecipes: 2,
            failedRecipes: 1,
            groupAssertions: 0,
            passedGroupAssertions: 0,
            failedGroupAssertions: 0,
            blockingFailures: 3
        },
        failures: [{
            kind: 'participant',
            key: agentIds[0]!,
            state: 'failed',
            required: true,
            error: { code: 'PARTICIPANT_FAILED', message: 'Preservation agent failed.' }
        }, {
            kind: 'recipe',
            key: MONITOR_RECIPE_IDS[0]!,
            state: 'failed',
            required: true,
            error: { code: 'RECIPE_FAILED', message: 'Preservation recipe failed.' }
        }, {
            kind: 'participant',
            key: agentIds[97]!,
            state: 'failed',
            required: true,
            error: { code: 'PARTICIPANT_TIMEOUT', message: 'Preservation agent timed out.' }
        }]
    };
}

function toMonitorResult(
    input: Readonly<{ controlRunId: string; agentIds: readonly string[]; commandId: string; index: number; }>
): ControlRunSnapshot['results'][number] {
    const ok = input.index % 33 !== 0;
    const error = { code: `FAIL_${input.index}`, message: `Failure ${input.index} for ${input.agentIds[input.index]}.` };
    return {
        kind: 'result',
        protocolVersion: 1,
        runId: input.controlRunId,
        agentId: input.agentIds[input.index]!,
        commandId: input.commandId,
        ok,
        result: {
            commandId: input.commandId,
            kind: 'health',
            status: ok ? 'ok' : 'failed',
            ok,
            startedAtEpochMs: 10_100 + input.index,
            endedAtEpochMs: 10_200 + input.index,
            durationMs: (input.index % 53) + 1,
            ...(ok ? {} : { error })
        },
        ...(ok ? {} : { error })
    };
}

function toMonitorEvent(
    input: Readonly<{ controlRunId: string; distributedRunId: string; agentId: string; commandId: string; index: number; }>
): ControlRunSnapshot['events'][number] {
    const isDiagnostic = input.index % 11 === 0;
    const payloadLinked = input.index % 19 === 0;
    return {
        kind: isDiagnostic ? 'diagnostic' : 'event',
        protocolVersion: 1,
        runId: input.controlRunId,
        agentId: input.agentId,
        atEpochMs: 10_150 + input.index,
        ...(input.index % 29 === 0 ? {} : { eventId: `event-${input.index}` }),
        ...(input.index % 23 === 0 ? { commandId: `unlinked-${input.index}` } : payloadLinked ? {} : { commandId: input.commandId }),
        payload: isDiagnostic
            ? {
                diagnosticSchemaVersion: 1,
                diagnosticTypeId: 'rtc.lane.mismatch',
                severity: input.index % 22 === 0 ? 'error' : 'warning',
                transport: 'messages.rtc',
                message: `Diagnostic ${input.index}`,
                data: { ...(payloadLinked ? { distributedRunId: input.distributedRunId } : {}), laneId: `lane:${input.index % 7}` }
            }
            : {
                topic: `topic:${input.index % 5}`,
                message: `Event ${input.index}`,
                ...(payloadLinked ? { distributedRunId: input.distributedRunId } : {})
            }
    };
}
