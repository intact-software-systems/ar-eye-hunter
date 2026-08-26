import { hashMutationCommand, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { computeRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/compute-rtc-rtt-mutation.ts';
import { readRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/read-rtc-rtt-mutation.ts';
import type { RtcRttMutationCommand, RtcRttMutationComputed } from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-contracts.ts';
import { validateRtcRttMutation } from '@shared-server/rallar-system/rtc-rtt/mutation/validate-rtc-rtt-mutation.ts';
import { DEFAULT_RTC_RTT_MUTATION_RETENTION_MS } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-persistence-validation.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/rtc-rtt/persistence/rtc-rtt-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import { createTestGroup } from '../../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';

export type TestExecuteRtcRttMutationInput = Readonly<{
    repository: RtcRttRepository;
    runtime: FakeRuntimeStateRepository;
    command: RtcRttMutationCommand;
    readFacts: () =>
        | Readonly<{
            requestedAtEpochMs: number;
            purgeAfterEpochMs: number;
        }>
        | Promise<
            Readonly<{
                requestedAtEpochMs: number;
                purgeAfterEpochMs: number;
            }>
        >;
    readCommand?: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
    sleep?: (delayMs: number) => Promise<void>;
}>;

export async function executeRtcRttMutation(input: TestExecuteRtcRttMutationInput) {
    const request = {
        rtt: input.command.rtt,
        alSenderId: input.command.alSenderId
    };
    const commandHash = await hashMutationCommand(request as JsonWireValue);
    for (let attemptCount = 1; attemptCount <= 20; attemptCount += 1) {
        try {
            const read = await readRtcRttMutation(input.repository, request);
            const command = read.receipt
                ? {
                    ...request,
                    candidateGroups: null,
                    overlaySnapshotsByGroupKey: null,
                    degreeLimit: null
                }
                : await (input.readCommand?.() ?? input.command);
            const lifecycle = read.receipt ? null : await input.readFacts();
            const facts = read.receipt
                ? ({
                    commandHash,
                    attemptCount,
                    requestedAtEpochMs: null,
                    purgeAfterEpochMs: null
                } as const)
                : {
                    ...lifecycle!,
                    commandHash,
                    attemptCount
                };
            const computed = computeRtcRttMutation({ command, read, facts });
            validateRtcRttMutation({ command, read, facts, computed });
            if (computed.outcome === 'write') {
                await input.runtime.begin(async () => {
                    for (const guard of computed.endpointGuards) {
                        requireTestRttWrite(
                            await input.repository.commitEndpointAdmission(
                                guard.value,
                                guard.expectedRevision,
                                guard.expireAtTimestamp
                            )
                        );
                    }
                    requireTestRttWrite(
                        await input.repository.commitMeasurement(
                            computed.measurementGuard.value,
                            computed.measurementGuard.expectedRevision,
                            computed.measurementGuard.purgeAfterEpochMs
                        )
                    );
                    requireTestRttWrite(
                        await input.repository.insertMutationReceipt(
                            computed.receipt,
                            computed.receipt.acceptedAtEpochMs + DEFAULT_RTC_RTT_MUTATION_RETENTION_MS
                        )
                    );
                });
            }
            return { computed, updated: computed.outcome === 'write' };
        }
        catch (error) {
            if (error instanceof RuntimeStateWriteConflictError && attemptCount < 20) {
                await input.sleep?.(0);
                continue;
            }
            throw error;
        }
    }
    throw new RuntimeStateWriteConflictError();
}

export function requireTestRttWrite(result: Readonly<{ status: 'accepted' | 'conflict'; }>): void {
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
}

export function createGroupRef(): GroupRef {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1'
    };
}

export function createPrincipalAuditStamp(atEpochMs: number, principalId: string) {
    return {
        atEpochMs,
        actor: { kind: 'principal' as const, principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}

export function createRttGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[]
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            activeMemberCount: sessionIds.length,
            ownerPrincipalId: sessionIds[0] ?? 'owner',
            created: createPrincipalAuditStamp(1, 'owner'),
            updated: createPrincipalAuditStamp(1, 'owner')
        }),
        members: sessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? ('owner' as const) : ('member' as const),
            status: 'active' as const,
            joined: createPrincipalAuditStamp(1, 'owner'),
            updated: createPrincipalAuditStamp(1, 'owner'),
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_001,
            status: 'active' as const,
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length
    };
}

type DeepMutable<Value> = Value extends readonly (infer Entry)[] ? DeepMutable<Entry>[] :
    Value extends object ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]>; } :
    Value;

type RttWriteCandidate = Extract<RtcRttMutationComputed, { outcome: 'write'; }>;
export type MutableRttWriteCandidate = DeepMutable<RttWriteCandidate>;

export function createValidRttWriteCandidate(): Extract<RtcRttMutationComputed, { outcome: 'write'; }> {
    const computed = computeRtcRttMutation({
        command: {
            rtt: {
                sessionIdFrom: 'session-a',
                sessionIdTo: 'session-b',
                rttMs: 1,
                createdAtEpochMs: 1,
                version: 1
            },
            alSenderId: 'session-a',
            candidateGroups: [createRttGroupSnapshot('room-write-gate', ['session-a', 'session-b'])],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 1
        },
        read: {
            receipt: null,
            measurement: null,
            expiredMeasurementEntry: null,
            endpointAdmissions: [],
            expiredEndpointAdmissionEntries: [],
            measurements: []
        },
        facts: {
            commandHash: `sha256:${'a'.repeat(64)}`,
            attemptCount: 1,
            requestedAtEpochMs: 2,
            purgeAfterEpochMs: 60_002
        }
    });
    if (computed.outcome !== 'write') {
        throw new Error('Expected RTT write');
    }
    return computed;
}

export function createMutableRttWriteCandidate(): MutableRttWriteCandidate {
    return structuredClone(createValidRttWriteCandidate()) as MutableRttWriteCandidate;
}

export const rttWriteCandidateCorruptions: readonly Readonly<{
    label: string;
    corrupt(candidate: MutableRttWriteCandidate): object;
}>[] = [
    {
        label: 'a missing endpoint guard field',
        corrupt: (candidate) => {
            const { endpointGuards: _removedEndpointGuards, ...withoutEndpointGuards } = candidate;
            return withoutEndpointGuards;
        }
    },
    {
        label: 'an extra write-candidate field',
        corrupt: (candidate) => ({ ...candidate, unexpected: true })
    },
    {
        label: 'only one endpoint guard',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: candidate.endpointGuards.slice(0, 1)
        })
    },
    {
        label: 'an extra endpoint guard',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: [...candidate.endpointGuards, structuredClone(candidate.endpointGuards[1]!)]
        })
    },
    {
        label: 'endpoint guards outside lexical order',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: [...candidate.endpointGuards].reverse()
        })
    },
    {
        label: 'duplicate endpoint guard identities',
        corrupt: (candidate) => {
            candidate.endpointGuards[1]!.endpointId = 'session-a';
            candidate.endpointGuards[1]!.value.endpointId = 'session-a';
            return candidate;
        }
    },
    {
        label: 'an extra endpoint guard field',
        corrupt: (candidate) => ({
            ...candidate,
            endpointGuards: candidate.endpointGuards.map((guard, index) => index === 0 ? { ...guard, unexpected: true } : guard)
        })
    },
    {
        label: 'an invalid endpoint expected revision',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.expectedRevision = -1;
            return candidate;
        }
    },
    ...([0, 1] as const).map((endpointIndex) => ({
        label: `endpoint ${endpointIndex + 1} insert domain version differing from its storage guard`,
        corrupt: (candidate: MutableRttWriteCandidate) => {
            candidate.endpointGuards[endpointIndex]!.value.version = 2;
            return candidate;
        }
    })),
    ...([0, 1] as const).map((endpointIndex) => ({
        label: `endpoint ${endpointIndex + 1} update domain version differing from its storage guard`,
        corrupt: (candidate: MutableRttWriteCandidate) => {
            candidate.endpointGuards[endpointIndex]!.expectedRevision = 0;
            candidate.endpointGuards[endpointIndex]!.value.version = 1;
            return candidate;
        }
    })),
    {
        label: 'an endpoint update whose next domain version would overflow',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.expectedRevision = Number.MAX_SAFE_INTEGER - 1;
            candidate.endpointGuards[0]!.value.version = Number.MAX_SAFE_INTEGER;
            return candidate;
        }
    },
    {
        label: 'an endpoint value bound to another identity',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.value.endpointId = 'session-c';
            return candidate;
        }
    },
    {
        label: 'an endpoint value missing the receipt peer',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.value.peers = [
                {
                    peerSessionId: 'session-c',
                    expiresAtEpochMs: 60_002
                }
            ];
            return candidate;
        }
    },
    {
        label: 'an endpoint lease before the measurement purge time',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.value.peers[0]!.expiresAtEpochMs = 60_001;
            candidate.endpointGuards[0]!.expireAtTimestamp = 60_001;
            return candidate;
        }
    },
    {
        label: 'an endpoint physical expiry differing from its leases',
        corrupt: (candidate) => {
            candidate.endpointGuards[0]!.expireAtTimestamp += 1;
            return candidate;
        }
    },
    {
        label: 'a missing measurement guard field',
        corrupt: (candidate) => {
            const {
                expectedRevision: _removedExpectedRevision,
                ...measurementGuardWithoutExpectedRevision
            } = candidate.measurementGuard;
            return { ...candidate, measurementGuard: measurementGuardWithoutExpectedRevision };
        }
    },
    {
        label: 'an extra measurement guard field',
        corrupt: (candidate) => ({
            ...candidate,
            measurementGuard: { ...candidate.measurementGuard, unexpected: true }
        })
    },
    {
        label: 'an invalid measurement expected revision',
        corrupt: (candidate) => {
            candidate.measurementGuard.expectedRevision = -1;
            return candidate;
        }
    },
    {
        label: 'a measurement value differing from receipt',
        corrupt: (candidate) => {
            candidate.measurementGuard.value = {
                ...candidate.measurementGuard.value,
                sessionIdTo: 'session-c'
            };
            return candidate;
        }
    },
    {
        label: 'an outbox identity differing from the affected group',
        corrupt: (candidate) => {
            candidate.receipt.outboxIds[0] = 'wrong-outbox-id';
            return candidate;
        }
    },
    {
        label: 'a missing sender identity',
        corrupt: (candidate) => {
            candidate.senderId = '';
            return candidate;
        }
    },
    {
        label: 'a purge time outside the accepted lifecycle',
        corrupt: (candidate) => {
            candidate.measurementGuard.purgeAfterEpochMs = 2;
            return candidate;
        }
    },
    {
        label: 'affected groups differing from receipt',
        corrupt: (candidate) => ({ ...candidate, affectedGroups: [] })
    }
];
