import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { AppTopics } from '@shared/api/api-config.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupPresenceSession,
    GroupRef,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    computeRttMutation,
    computeTopologyMutation,
    type RtcTopologyPublicationClaim,
    validateRttMutation,
    validateTopologyMutation,
} from '@shared-server/rallar-system/services/rtc-topology-mutations.ts';
import { toRtcRttMutationReceiptId } from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import { toRtcTopologyPublicationMessageId } from '@shared-server/rallar-system/rtc-topology-identifiers.ts';
import { writeRttMutation } from '@shared-server/rallar-system/services/rtc-rtt-mutation-service.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

const RTT_COMMAND_HASH = `sha256:${'a'.repeat(64)}`;
const OTHER_RTT_COMMAND_HASH = `sha256:${'b'.repeat(64)}`;

describe('RTC topology mutation phases', () => {
    it('keeps RTC topology mutation computation synchronous and effect-free', () => {
        const source = readFileSync(new URL(
            '../../shared-server/rallar-system/services/rtc-topology-mutations.ts',
            import.meta.url,
        ), 'utf8');
        const forbidden = [
            /\brepository\b/,
            /\.begin\s*\(/,
            /\b(?:Date|Temporal)\b/,
            /random/i,
            /(?:Deno|process)\.env/,
            /hashStateMutationCommand/,
            /recordRallarTiming|performance\.now/,
            /\b(?:async|await)\b/,
        ];

        for (const pattern of forbidden) {
            expect(source, `forbidden pure-module pattern ${pattern}`).not.toMatch(pattern);
        }
    });

    it('shares strict persisted publication and RTT validators from neutral pure contract modules', () => {
        const publicationContractUrl = new URL(
            '../../shared-server/rallar-system/rtc-topology-publication-validation.ts',
            import.meta.url,
        );
        const rttContractUrl = new URL(
            '../../shared-server/rallar-system/rtc-rtt-persistence-validation.ts',
            import.meta.url,
        );
        expect(existsSync(publicationContractUrl)).toBe(true);
        expect(existsSync(rttContractUrl)).toBe(true);
        if (!existsSync(publicationContractUrl) || !existsSync(rttContractUrl)) {
            return;
        }

        for (const contractUrl of [publicationContractUrl, rttContractUrl]) {
            const contractSource = readFileSync(contractUrl, 'utf8');
            expect(contractSource).not.toMatch(
                /\.begin\s*\(|\b(?:async|await)\b|\b(?:Date|Temporal)\b|performance\.now|(?:Deno|process)\.env/,
            );
            expect(contractSource).not.toMatch(/\/repositories\//);
        }
        const mutationSource = readFileSync(new URL(
            '../../shared-server/rallar-system/services/rtc-topology-mutations.ts',
            import.meta.url,
        ), 'utf8');
        const rttRepositorySource = readFileSync(new URL(
            '../../shared-server/rallar-system/repositories/RtcRttRepository.ts',
            import.meta.url,
        ), 'utf8');
        const publicationRepositorySource = readFileSync(new URL(
            '../../shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts',
            import.meta.url,
        ), 'utf8');
        expect(mutationSource).toMatch(/rtc-topology-publication-validation/);
        expect(mutationSource).toMatch(/rtc-rtt-persistence-validation/);
        expect(rttRepositorySource).toMatch(/rtc-rtt-persistence-validation/);
        expect(publicationRepositorySource)
            .toMatch(/rtc-topology-publication-validation/);
    });

    it('keeps RTT phases explicit while AppInbox exclusively owns retries and transactions', () => {
        const serviceUrl = new URL(
            '../../shared-server/rallar-system/services/rtc-rtt-mutation-service.ts',
            import.meta.url,
        );

        expect(existsSync(serviceUrl)).toBe(true);
        if (!existsSync(serviceUrl)) return;
        const source = readFileSync(serviceUrl, 'utf8');
        const readIndex = source.indexOf('await readRttMutation(');
        const computeIndex = source.indexOf('computeRttMutation(');
        const validateIndex = source.indexOf('validateRttMutation(');
        const writeIndex = source.indexOf('await writeRttMutation(');
        expect([readIndex, computeIndex, validateIndex, writeIndex])
            .toEqual([...new Set([readIndex, computeIndex, validateIndex, writeIndex])]
                .toSorted((left, right) => left - right));
        expect(readIndex).toBeGreaterThanOrEqual(0);
        expect(source).not.toMatch(/\.begin\s*\(/);
        expect(source).not.toMatch(/waitForRuntimeStateWriteRetry|\bfor\s*\([^)]*attempt/);
        expect(source).not.toMatch(/\bsleep\??\s*:/);
        const writeFunctionIndex = source.indexOf('export async function writeRttMutation');
        const writeFunction = source.slice(
            writeFunctionIndex,
            source.indexOf('\n}', writeFunctionIndex) + 2,
        );
        expect(writeFunction).toMatch(/transaction:\s*PSqlTransactionSql/);
        expect(writeFunction).not.toMatch(/RuntimeStateOptimisticTransactionalRepositoryLike/);
    });

    it('declares every topology ingress command and routes each through AppGroupInbox', () => {
        const contracts = readFileSync(new URL(
            '../../shared-server/rallar-system/services/app-inbox-contracts.ts',
            import.meta.url,
        ), 'utf8');
        const service = readFileSync(new URL(
            '../../shared-server/rallar-system/services/AppGroupInboxService.ts',
            import.meta.url,
        ), 'utf8');
        const expected = [
            'TOPOLOGY_CONFIG_PUT',
            'TOPOLOGY_CONFIG_DELETE',
            'TOPOLOGY_OVERRIDE_PUT',
            'TOPOLOGY_OVERRIDE_DELETE',
            'TOPOLOGY_RECONFIGURE',
            'RTC_RTT_SUBMIT',
        ];

        for (const operation of expected) {
            expect(contracts).toContain(`${operation} = '${operation}'`);
            expect(service).toContain(`AppInboxType.${operation}`);
        }
        expect(service).toMatch(/readTopologyMutation[\s\S]*computeTopologyMutation/);
        expect(service).toMatch(/computeTopologyMutation[\s\S]*validateTopologyMutation/);
        expect(service).toMatch(/validateTopologyMutation[\s\S]*writeMutation\(/);
    });

    it('keeps receipt-family cleanup reads and validation outside its write transaction', () => {
        const source = readFileSync(new URL(
            '../../shared-server/rallar-system/repositories/RtcRttRepository.ts',
            import.meta.url,
        ), 'utf8');
        const cleanupStart = source.indexOf(
            'private async cleanupExpiredReceiptFamily(',
        );
        const writeStart = source.indexOf(
            'private async writeExpiredReceiptFamilyCleanup(',
            cleanupStart,
        );
        const cleanupSection = source.slice(cleanupStart, writeStart);
        const readIndex = cleanupSection.indexOf(
            'await this.readExpiredReceiptFamilyCleanup(',
        );
        const computeIndex = cleanupSection.indexOf(
            'this.computeExpiredReceiptFamilyCleanup(',
        );
        const validateIndex = cleanupSection.indexOf(
            'this.validateExpiredReceiptFamilyCleanup(',
        );
        const writeIndex = cleanupSection.indexOf(
            'await this.writeExpiredReceiptFamilyCleanup(',
        );

        expect(cleanupStart).toBeGreaterThanOrEqual(0);
        expect(writeStart).toBeGreaterThan(cleanupStart);
        expect([readIndex, computeIndex, validateIndex, writeIndex])
            .toEqual([...new Set([readIndex, computeIndex, validateIndex, writeIndex])]
                .toSorted((left, right) => left - right));
        expect(readIndex).toBeGreaterThanOrEqual(0);

        const writeEnd = source.indexOf('\n    }\n}\n\nexport function', writeStart);
        const writeSection = source.slice(writeStart, writeEnd);
        expect(writeSection).toContain('runtime.begin(');
        expect(writeSection).not.toMatch(/\.findEntry|\.findEntriesByPrefix/);
        expect(writeSection.indexOf('.upsertIfRevision(')).toBeLessThan(
            writeSection.indexOf('.deleteIfRevision('),
        );
    });

    it('computes and validates an absent topology guard deterministically from frozen input', () => {
        const groupRef: GroupRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1',
        };
        const candidate = topologySnapshot(groupRef, 1);
        const input = deepFreeze({
            read: {
                snapshot: null,
                publicationClaim: null,
            },
            candidate,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        });

        const first = computeAndValidateTopologyTwice(input);
        const second = computeTopologyMutation(input);

        expect(second).toEqual(first);
        expect(first).toMatchObject({
            outcome: 'write',
            snapshotGuard: { expectedRevision: null, candidate },
        });
        if (first.outcome !== 'write') throw new Error('Expected topology write');
        const tampered = {
            ...first,
            snapshotGuard: {
                ...first.snapshotGuard,
                candidate: { ...first.snapshotGuard.candidate, name: 'tampered' },
            },
        };
        expect(() => validateTopologyMutation({ ...input, computed: tampered }))
            .toThrow('differs from canonical');
        expect(() => validateTopologyMutation({ ...input, computed: tampered }))
            .toThrow('differs from canonical');
    });

    it('computes stale RTT rejection deterministically without mutating frozen reads', () => {
        const incoming = {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 5,
            createdAtEpochMs: 2,
            version: 2,
        };
        const input = deepFreeze({
            command: {
                rtt: incoming,
                alSenderId: 'session-a',
                candidateGroups: [],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 1,
            },
            read: {
                receipt: null,
                measurement: {
                    entry: {
                        key: 'pair=session-a%3A%3Asession-b',
                        value: JSON.stringify({ ...incoming, version: 3 }),
                        expireAtTimestamp: 10_000,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 4,
                    },
                    value: { ...incoming, version: 3 },
                },
                endpointAdmissions: [],
                measurements: [{
                    entry: {
                        key: 'from=session-a:to=session-b',
                        value: JSON.stringify({ ...incoming, version: 3 }),
                        expireAtTimestamp: 10_000,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 4,
                    },
                    value: { ...incoming, version: 3 },
                }],
            },
            facts: {
                purgeAfterEpochMs: 10_000,
                requestedAtEpochMs: 2,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1,
            },
        });

        const first = computeAndValidateRttTwice(input);
        const second = computeRttMutation(input);

        expect(second).toEqual(first);
        expect(first).toMatchObject({ outcome: 'rejected', reason: 'stale' });
    });

    it('loads only the durable publication winner and rejects a claim without its snapshot', () => {
        const groupRef = {
            applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1',
        };
        const snapshot = topologySnapshot(groupRef, 2);
        const publication = topologyPublication(snapshot, 'work-1');
        const entry = {
            key: 'snapshot', value: JSON.stringify(snapshot),
            expireAtTimestamp: 1_000, updatedTimestamp: 'now', revision: 3,
        };
        const loadedInput = deepFreeze({
            read: {
                snapshot: { entry, value: snapshot },
                publicationClaim: topologyPublicationClaim(publication),
            },
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        });
        expect(computeAndValidateTopologyTwice(loadedInput))
            .toEqual({ outcome: 'loaded', snapshot, publication });
        const missingSnapshot = deepFreeze({
            read: {
                snapshot: null,
                publicationClaim: topologyPublicationClaim(publication),
            },
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        });
        expect(() => computeTopologyMutation(missingSnapshot)).toThrow('has no durable snapshot');
        expect(() => computeTopologyMutation(missingSnapshot)).toThrow('has no durable snapshot');
        const inconsistent = deepFreeze({
            ...loadedInput,
            read: {
                ...loadedInput.read,
                publicationClaim: {
                    ...topologyPublicationClaim(publication),
                    publication: { ...publication, recipientSessionIds: ['session-z'] },
                },
            },
        });
        expect(() => computeTopologyMutation(inconsistent)).toThrow('internally inconsistent');
        expect(() => computeTopologyMutation(inconsistent)).toThrow('internally inconsistent');
    });

    it('relates a claimed publication payload to the independently read snapshot', () => {
        const groupRef = {
            applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1',
        };
        const publicationSnapshot = topologySnapshot(groupRef, 2);
        const publication = topologyPublication(
            publicationSnapshot,
            'work-causal',
        );
        const toRead = (snapshot: RallarOverlayTopologySnapshot) => ({
            snapshot: {
                entry: {
                    key: 'snapshot',
                    value: JSON.stringify(snapshot),
                    expireAtTimestamp: 1_000,
                    updatedTimestamp: 'now',
                    revision: 3,
                },
                value: snapshot,
            },
            publicationClaim: topologyPublicationClaim(publication),
        });
        const exactInput = deepFreeze({
            read: toRead(publicationSnapshot),
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        });
        expect(computeAndValidateTopologyTwice(exactInput)).toEqual({
            outcome: 'loaded',
            snapshot: publicationSnapshot,
            publication,
        });

        const reorderedEquivalent = {
            ...publicationSnapshot,
            groupRef: {
                groupId: groupRef.groupId,
                applicationId: groupRef.applicationId,
                workspaceId: groupRef.workspaceId,
            },
            nextHopsBySessionId: {
                'session-b': ['session-a'],
                'session-a': ['session-b'],
            },
        };
        const reorderedInput = deepFreeze({
            read: toRead(reorderedEquivalent),
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        });
        expect(computeAndValidateTopologyTwice(reorderedInput)).toEqual({
            outcome: 'loaded',
            snapshot: reorderedEquivalent,
            publication,
        });

        const newerDurable = topologySnapshot(groupRef, 3);
        const newerInput = deepFreeze({
            read: toRead(newerDurable),
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        });
        expect(computeAndValidateTopologyTwice(newerInput)).toEqual({
            outcome: 'loaded',
            snapshot: newerDurable,
            publication,
        });

        const olderDurable = topologySnapshot(groupRef, 1);
        const tornInput = deepFreeze({
            read: toRead(olderDurable),
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        });
        expect(computeAndValidateTopologyTwice(tornInput)).toEqual({
            outcome: 'retry',
            reason: 'publication-ahead-of-snapshot',
        });

        const equalTupleDifferentSnapshot = {
            ...publicationSnapshot,
            name: 'different durable payload',
        };
        const corruptInput = deepFreeze({
            read: toRead(equalTupleDifferentSnapshot),
            candidate: null,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        });
        expect(() => computeTopologyMutation(corruptInput))
            .toThrow('equal causal tuple differs from durable snapshot');
        expect(() => computeTopologyMutation(corruptInput))
            .toThrow('equal causal tuple differs from durable snapshot');
    });

    it('materializes publication expiry in canonical computed topology output', () => {
        const groupRef = {
            applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1',
        };
        const candidate = topologySnapshot(groupRef, 1);
        const publication = topologyPublication(candidate, 'work-expiry');
        const input = deepFreeze({
            read: { snapshot: null, publicationClaim: null },
            candidate,
            publication,
            facts: {
                publicationExpireAtTimestamp: 86_400_123,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1,
            },
        });

        expect(computeAndValidateTopologyTwice(input)).toMatchObject({
            outcome: 'write',
            publicationExpireAtTimestamp: 86_400_123,
        });
    });

    it('validates the complete topology publication envelope before the write phase', () => {
        const groupRef = {
            applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1',
        };
        const candidate = topologySnapshot(groupRef, 1);
        const publication = topologyPublication(candidate, 'work-malformed-envelope');
        const malformed = {
            ...publication,
            message: {
                ...publication.message,
                id: {
                    ...publication.message.id,
                    msgId: 'nondeterministic-message-id',
                },
            },
        };
        const input = deepFreeze({
            read: { snapshot: null, publicationClaim: null },
            candidate,
            publication: malformed,
            facts: {
                publicationExpireAtTimestamp: 86_400_100,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1,
            },
        });
        const computed = computeTopologyMutation(input);

        expect(() => validateTopologyMutation({ ...input, computed }))
            .toThrow(/message|publication|envelope|identity/i);
    });

    it('computes duplicate, advanced, and superseded topology outcomes', () => {
        const groupRef = {
            applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1',
        };
        const current = topologySnapshot(groupRef, 2);
        const entry = {
            key: 'snapshot', value: JSON.stringify(current),
            expireAtTimestamp: 1_000, updatedTimestamp: 'now', revision: 5,
        };
        expect(computeAndValidateTopologyTwice(deepFreeze({
            read: { snapshot: { entry, value: current }, publicationClaim: null },
            candidate: current,
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        }))).toMatchObject({ outcome: 'write', observation: 'duplicate' });
        expect(computeAndValidateTopologyTwice(deepFreeze({
            read: { snapshot: { entry, value: current }, publicationClaim: null },
            candidate: topologySnapshot(groupRef, 3),
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        }))).toMatchObject({ outcome: 'write', observation: 'advanced' });
        expect(computeAndValidateTopologyTwice(deepFreeze({
            read: { snapshot: { entry, value: current }, publicationClaim: null },
            candidate: topologySnapshot(groupRef, 1),
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        }))).toEqual({ outcome: 'superseded', current });
        const corrupt = deepFreeze({
            read: { snapshot: { entry, value: current }, publicationClaim: null },
            candidate: { ...current, name: 'different tuple payload' },
            publication: null,
            facts: {
                publicationExpireAtTimestamp: null,
                commandHash: null,
                attemptCount: null,
            },
        });
        expect(() => computeTopologyMutation(corrupt)).toThrow('revision conflict');
        expect(() => computeTopologyMutation(corrupt)).toThrow('revision conflict');
    });

    it('computes policy rejection, endpoint-cap rejection, and accepted RTT intents', () => {
        const rtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 1, version: 1,
        };
        const group = rttGroupSnapshot(['session-a', 'session-b']);
        const base = {
            command: {
                rtt, alSenderId: 'session-a', candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1,
            },
            facts: {
                requestedAtEpochMs: 1,
                purgeAfterEpochMs: 60_001,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1,
            },
        };
        const emptyRead = {
            receipt: null,
            measurement: null,
            endpointAdmissions: [],
            measurements: [],
        };
        expect(computeAndValidateRttTwice(deepFreeze({
            ...base,
            command: { ...base.command, candidateGroups: [] },
            read: emptyRead,
        }))).toMatchObject({ outcome: 'rejected', reason: 'no-shared-active-group' });
        expect(computeAndValidateRttTwice(deepFreeze({
            ...base,
            read: {
                ...emptyRead,
                endpointAdmissions: [{
                    entry: { key: 'endpoint=session-a', value: '', expireAtTimestamp: 60_001, updatedTimestamp: 'now', revision: 0 },
                    value: {
                        endpointId: 'session-a',
                        peers: [{ peerSessionId: 'session-c', expiresAtEpochMs: 60_001 }],
                        version: 1,
                        updatedAtEpochMs: 0,
                    },
                }],
            },
        }))).toMatchObject({ outcome: 'rejected', reason: 'over-degree' });
        const acceptedInput = deepFreeze({ ...base, read: emptyRead });
        const accepted = computeAndValidateRttTwice(acceptedInput);
        expect(accepted).toMatchObject({
            outcome: 'write',
            receipt: { outcome: 'accepted', measurementVersion: 1 },
            recomputeIntents: [{ groupSnapshot: group, rtt }],
        });
        if (accepted.outcome !== 'write') throw new Error('Expected RTT write');
        expect(accepted.endpointGuards.map(({ endpointId }) => endpointId))
            .toEqual(['session-a', 'session-b']);
        const tampered = {
            ...accepted,
            endpointGuards: [...accepted.endpointGuards].reverse(),
        };
        expect(() => validateRttMutation({ ...acceptedInput, computed: tampered }))
            .toThrow('differs from canonical');
        expect(() => validateRttMutation({ ...acceptedInput, computed: tampered }))
            .toThrow('differs from canonical');
    });

    it('rejects a malformed complete RTT write candidate before opening a transaction', async () => {
        const rtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 1, version: 1,
        };
        const group = rttGroupSnapshot(['session-a', 'session-b']);
        const computed = computeRttMutation({
            command: {
                rtt, alSenderId: 'session-a', candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1,
            },
            read: {
                receipt: null,
                measurement: null,
                endpointAdmissions: [],
                measurements: [],
            },
            facts: {
                requestedAtEpochMs: 1,
                purgeAfterEpochMs: 60_001,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1,
            },
        });
        if (computed.outcome !== 'write') throw new Error('Expected RTT write');
        const malformed = structuredClone(computed) as typeof computed;
        delete (malformed.recomputeIntents[0]!.groupSnapshot as unknown as {
            causalRevision?: unknown;
        }).causalRevision;
        const runtime = new FakeRuntimeStateRepository();
        const begin = vi.spyOn(runtime, 'begin');

        await expect(writeRttMutation(
            runtime,
            { ttlMs: 60_000, now: () => 1 },
            malformed,
        )).rejects.toThrow();
        expect(begin).not.toHaveBeenCalled();
        await expect(runtime.findAllEntries('rtc-rtt:latest')).resolves.toEqual([]);
    });

    it('requires both RTT endpoint sessions to cover the full active interval at acceptance time', () => {
        const rtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 1, version: 1,
        };
        const baseGroup = rttGroupSnapshot(['session-a', 'session-b']);
        const withBounds = (
            connectedAtEpochMs: number,
            expiresAtEpochMs: number,
        ): GroupSnapshot => ({
            ...baseGroup,
            activeSessions: baseGroup.activeSessions.map((session) => ({
                ...session,
                connectedAtEpochMs,
                lastHeartbeatAtEpochMs: Math.max(
                    session.lastHeartbeatAtEpochMs,
                    connectedAtEpochMs,
                ),
                expiresAtEpochMs,
            })),
        });
        const computeAt = (
            requestedAtEpochMs: number,
            group: GroupSnapshot,
        ) => computeRttMutation({
            command: {
                rtt, alSenderId: 'session-a', candidateGroups: [group],
                overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1,
            },
            read: {
                receipt: null,
                measurement: null,
                endpointAdmissions: [],
                measurements: [],
            },
            facts: {
                requestedAtEpochMs,
                purgeAfterEpochMs: requestedAtEpochMs + 60_000,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1,
            },
        });

        expect(computeAt(1, withBounds(2, 10))).toMatchObject({
            outcome: 'rejected', reason: 'no-shared-active-group',
        });
        expect(computeAt(2, withBounds(2, 10))).toMatchObject({ outcome: 'write' });
        expect(computeAt(10, withBounds(2, 10))).toMatchObject({
            outcome: 'rejected', reason: 'no-shared-active-group',
        });
    });

    it('computes every RTT policy rejection family twice from frozen authority', () => {
        const group = rttGroupSnapshot(['session-a', 'session-b', 'session-c']);
        const validRtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 1, version: 1,
        };
        const emptyRead = {
            receipt: null,
            measurement: null,
            endpointAdmissions: [],
            measurements: [],
        };
        const reportingOverlay = {
            ...topologySnapshot(group.group, 1),
            activeSessionIds: ['session-a', 'session-b', 'session-c'],
            nextHopsBySessionId: {
                'session-a': ['session-c'],
                'session-b': ['session-c'],
                'session-c': ['session-a'],
            },
            degreeLimit: 1,
        };
        const cases = [
            {
                reason: 'invalid-rtt',
                command: { rtt: { ...validRtt, rttMs: 0 }, alSenderId: 'session-a', candidateGroups: [group], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 },
            },
            {
                reason: 'self-pair',
                command: { rtt: { ...validRtt, sessionIdTo: 'session-a' }, alSenderId: 'session-a', candidateGroups: [group], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 },
            },
            {
                reason: 'sender-mismatch',
                command: { rtt: validRtt, alSenderId: 'session-c', candidateGroups: [group], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 },
            },
            {
                reason: 'no-shared-active-group',
                command: { rtt: validRtt, alSenderId: 'session-a', candidateGroups: [], overlaySnapshotsByGroupKey: new Map(), degreeLimit: 1 },
            },
            {
                reason: 'not-reporting-edge',
                command: {
                    rtt: validRtt, alSenderId: 'session-a', candidateGroups: [group],
                    overlaySnapshotsByGroupKey: new Map([[toWebRtcGroupKey(group.group), reportingOverlay]]),
                    degreeLimit: 1,
                },
            },
        ] as const;
        for (const testCase of cases) {
            const input = deepFreeze({
                command: testCase.command,
                read: emptyRead,
                facts: {
                    requestedAtEpochMs: 1,
                    purgeAfterEpochMs: 60_001,
                    commandHash: RTT_COMMAND_HASH,
                    attemptCount: 1,
                },
            });
            expect(computeAndValidateRttTwice(input))
                .toMatchObject({ outcome: 'rejected', reason: testCase.reason });
        }
    });

    it('accepts equal RTT version only when the canonical measurement is exact', () => {
        const incoming = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 2, version: 2,
        };
        const readFor = (value: typeof incoming) => ({
            receipt: null,
            measurement: {
                entry: {
                    key: 'from=session-a:to=session-b',
                    value: JSON.stringify(value),
                    expireAtTimestamp: 10_000,
                    updatedTimestamp: 'now',
                    revision: 4,
                },
                value,
            },
            endpointAdmissions: [],
            measurements: [],
        });
        const command = {
            rtt: incoming,
            alSenderId: 'session-a',
            candidateGroups: [],
            overlaySnapshotsByGroupKey: new Map(),
            degreeLimit: 1,
        };
        const facts = {
            purgeAfterEpochMs: 10_000,
            requestedAtEpochMs: 2,
            commandHash: RTT_COMMAND_HASH,
            attemptCount: 1,
        };
        expect(computeAndValidateRttTwice(deepFreeze({
            command,
            read: readFor(incoming),
            facts,
        }))).toMatchObject({ outcome: 'rejected', reason: 'stale' });

        const conflicting = deepFreeze({
            command,
            read: readFor({ ...incoming, rttMs: 99 }),
            facts,
        });
        expect(() => computeRttMutation(conflicting))
            .toThrow('equal version differs from durable measurement');
        expect(() => computeRttMutation(conflicting))
            .toThrow('equal version differs from durable measurement');
    });

    it('computes an exact receipt replay twice from frozen immutable authority', () => {
        const rtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 2, version: 2,
        };
        const receiptId = toRtcRttMutationReceiptId(rtt);
        const receipt = {
            receiptId,
            commandId: receiptId,
            requestId: receiptId,
            sessionIdFrom: rtt.sessionIdFrom,
            sessionIdTo: rtt.sessionIdTo,
            aggregateRef: {
                sessionIdFrom: rtt.sessionIdFrom,
                sessionIdTo: rtt.sessionIdTo,
            },
            measurementVersion: rtt.version,
            affectedGroupRefs: [],
            acceptedAtEpochMs: 1,
            outcome: 'accepted' as const,
            attemptCount: 1,
            acceptedStorageRevision: 0,
            eventId: null,
            outboxIds: [],
            commandHash: RTT_COMMAND_HASH,
        };
        const input = deepFreeze({
            command: {
                rtt,
                alSenderId: 'session-a',
                candidateGroups: null,
                overlaySnapshotsByGroupKey: null,
                degreeLimit: null,
            },
            read: {
                receipt: {
                    entry: {
                        key: receiptId,
                        value: JSON.stringify(receipt),
                        expireAtTimestamp: 86_400_001,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 0,
                    },
                    value: receipt,
                },
            },
            facts: {
                requestedAtEpochMs: null,
                purgeAfterEpochMs: null,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1,
            },
        });

        expect(computeAndValidateRttTwice(input)).toEqual({
            outcome: 'replay',
            reason: 'accepted',
            affectedGroups: [],
            receipt,
        });
    });

    it('rejects divergent pair/version reuse from frozen receipt authority twice', () => {
        const rtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 2, version: 2,
        };
        const receiptId = toRtcRttMutationReceiptId(rtt);
        const receipt = {
            receiptId,
            commandId: receiptId,
            requestId: receiptId,
            sessionIdFrom: rtt.sessionIdFrom,
            sessionIdTo: rtt.sessionIdTo,
            aggregateRef: {
                sessionIdFrom: rtt.sessionIdFrom,
                sessionIdTo: rtt.sessionIdTo,
            },
            measurementVersion: rtt.version,
            affectedGroupRefs: [],
            acceptedAtEpochMs: 1,
            outcome: 'accepted' as const,
            attemptCount: 1,
            acceptedStorageRevision: 0,
            eventId: null,
            outboxIds: [],
            commandHash: OTHER_RTT_COMMAND_HASH,
        };
        const input = deepFreeze({
            command: {
                rtt,
                alSenderId: 'session-a',
                candidateGroups: null,
                overlaySnapshotsByGroupKey: null,
                degreeLimit: null,
            },
            read: {
                receipt: {
                    entry: {
                        key: receiptId,
                        value: JSON.stringify(receipt),
                        expireAtTimestamp: 86_400_001,
                        updatedTimestamp: '1970-01-01T00:00:00.000Z',
                        revision: 0,
                    },
                    value: receipt,
                },
            },
            facts: {
                requestedAtEpochMs: null,
                purgeAfterEpochMs: null,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1,
            },
        });

        expect(() => computeRttMutation(input)).toThrowError(expect.objectContaining({
            code: 'rtc-rtt-idempotency-conflict',
        }));
        expect(() => computeRttMutation(input)).toThrowError(expect.objectContaining({
            code: 'rtc-rtt-idempotency-conflict',
        }));
    });

    it('emits canonical unique affected refs and one recompute intent per ref', () => {
        const refA = {
            applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-a',
        };
        const refB = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-a',
        };
        const groupA = rttGroupSnapshot(['session-a', 'session-b'], refA);
        const groupB = rttGroupSnapshot(['session-a', 'session-b'], refB);
        const rtt = {
            sessionIdFrom: 'session-a', sessionIdTo: 'session-b',
            rttMs: 5, createdAtEpochMs: 2, version: 2,
        };
        const computed = computeRttMutation({
            command: {
                rtt,
                alSenderId: 'session-a',
                candidateGroups: [groupB, groupA, groupA],
                overlaySnapshotsByGroupKey: new Map(),
                degreeLimit: 2,
            },
            read: {
                receipt: null,
                measurement: null,
                endpointAdmissions: [],
                measurements: [],
            },
            facts: {
                requestedAtEpochMs: 2,
                purgeAfterEpochMs: 60_002,
                commandHash: RTT_COMMAND_HASH,
                attemptCount: 1,
            },
        });

        expect(computed.outcome).toBe('write');
        if (computed.outcome !== 'write') throw new Error('Expected write');
        expect(computed.receipt.affectedGroupRefs).toEqual([refB, refA]);
        expect(computed.recomputeIntents.map(({ groupSnapshot }) =>
            groupSnapshot.group
        )).toEqual([expect.objectContaining(refB), expect.objectContaining(refA)]);
    });
});

function topologySnapshot(
    groupRef: GroupRef,
    version: number,
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: version,
            presenceRevision: version,
        },
        state: 'active',
        overlayId: JSON.stringify([
            groupRef.applicationId,
            groupRef.workspaceId ?? '',
            groupRef.groupId,
        ]),
        groupRef,
        name: 'Room 1',
        topology: 'tree',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        },
        degreeLimit: 5,
        version,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
    } as const;
}

function topologyPublication(
    snapshot: RallarOverlayTopologySnapshot,
    workId: string,
) {
    const createdAtEpochMs = 100;
    return {
        publicationId:
            `${workId}:${snapshot.sourceGroupStateCausalRevision.groupRevision}:${snapshot.sourceGroupStateCausalRevision.presenceRevision}:${snapshot.version}`,
        workId,
        groupRef: snapshot.groupRef,
        sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 1,
        recipientSessionIds: snapshot.activeSessionIds,
        message: {
            id: {
                v: 2,
                msgId: toRtcTopologyPublicationMessageId(workId),
                ts: createdAtEpochMs,
                senderId: 'rallar-server',
            },
            route: {
                topicId: AppTopics.overlayTopology,
                contextId: snapshot.groupRef.groupId,
                resourceId:
                    `${snapshot.overlayId}:${snapshot.sourceGroupStateCausalRevision.groupRevision}:${snapshot.sourceGroupStateCausalRevision.presenceRevision}:${snapshot.version}`,
            },
            targets: {
                mode: 'broadcast',
                scope: 'room',
                groupRef: snapshot.groupRef,
                minSnapshotVersion: 1,
            },
            delivery: { reliability: 'best-effort', ack: 'none' },
            payload: {
                typeId: AppTopics.overlayTopology,
                contentType: 'application/json',
                resource: JSON.stringify(snapshot),
            },
            audit: {
                createdBy: 'rallar-server',
                createdTs: createdAtEpochMs,
            },
        },
        createdAtEpochMs,
    } as const;
}

function topologyPublicationClaim(
    publication: ReturnType<typeof topologyPublication>,
): RtcTopologyPublicationClaim {
    return {
        receipt: {
            kind: 'rtc-topology-execution-receipt',
            schemaVersion: 1,
            groupRef: publication.groupRef,
            workId: publication.workId,
            commandId: publication.workId,
            requestId: publication.workId,
            commandHash: RTT_COMMAND_HASH,
            publicationId: publication.publicationId,
            outcome: 'accepted',
            attemptCount: 1,
            acceptedCausalRevision:
                publication.sourceGroupStateCausalRevision,
            acceptedStorageRevision: 0,
            eventId: null,
            outboxIds: [publication.publicationId],
        },
        publication,
    };
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        if (value instanceof Map) {
            for (const [key, child] of value.entries()) {
                deepFreeze(key);
                deepFreeze(child);
            }
        }
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}

function computeAndValidateTopologyTwice(
    input: Parameters<typeof computeTopologyMutation>[0],
) {
    const first = computeTopologyMutation(input);
    const second = computeTopologyMutation(input);
    expect(second).toEqual(first);
    expect(() => validateTopologyMutation({ ...input, computed: first })).not.toThrow();
    expect(() => validateTopologyMutation({ ...input, computed: first })).not.toThrow();
    return first;
}

function computeAndValidateRttTwice(
    input: Parameters<typeof computeRttMutation>[0],
) {
    const first = computeRttMutation(input);
    const second = computeRttMutation(input);
    expect(second).toEqual(first);
    expect(() => validateRttMutation({ ...input, computed: first })).not.toThrow();
    expect(() => validateRttMutation({ ...input, computed: first })).not.toThrow();
    return first;
}

function rttGroupSnapshot(
    sessionIds: readonly string[],
    groupRef: GroupRef = {
        applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1',
    },
): GroupSnapshot {
    const ownerPrincipalId = sessionIds[0];
    if (!ownerPrincipalId) {
        throw new Error('Expected at least one session fixture');
    }
    const stamp: AuditStamp = {
        atEpochMs: 1,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null,
    };
    return {
        stateRevision: 2,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: {
            ...groupRef,
            slug: null,
            displayName: 'Room 1',
            description: null,
            kind: 'room',
            status: 'active',
            archived: null,
            deleted: null,
            joinMode: 'open', metadata: {}, snapshotVersion: 1, metadataVersion: 1,
            maxMembers: null,
            maxSessionsPerMember: null,
            rosterVersion: 1, presenceVersion: 1,
            activeMemberCount: sessionIds.length,
            ownerPrincipalId,
            expiresAtEpochMs: null,
            emptySinceEpochMs: null,
            purgeAfterEpochMs: null,
            created: stamp,
            updated: stamp,
        },
        members: sessionIds.map<GroupMember>((sessionId, index) => ({
            ...groupRef, principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: stamp,
            updated: stamp,
        })),
        activeSessions: sessionIds.map<GroupPresenceSession>((sessionId) => ({
            ...groupRef, sessionId, principalId: sessionId,
            generationId: `${sessionId}-generation`, generationVersion: 1,
            connectedAtEpochMs: 1, lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_001,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}
