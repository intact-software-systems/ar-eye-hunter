import { describe, expect, it } from 'vitest';

import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import {
    toRtcRttMutationReceiptId,
    toRtcRttTopologyOutboxId
} from '@shared-server/rallar-system/rtc-rtt/mutation/rtc-rtt-mutation-identifiers.ts';
import { computeRtcTopologyOutboxInsert } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import {
    childKey,
    decodeChildKey
} from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-state.ts';
import {
    readRtcTopologyWorkEnvelope,
    toRtcTopologyExecutionId
} from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { isAdminTopologyOutboxId } from '@shared/api/admin-rooms/decode-admin-room-topology-work.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { COALESCED_APP_OUTBOX_WORK_FIELD } from '@shared/queuebox/coalesced-app-outbox-work-envelope.ts';

import { createRtcTopologyGroupSnapshot, createRtcTopologyRttMeasurement } from '../../rtc-topology-test-fixtures.ts';

// The longest route id the system admits (128 characters), made of colons so every storage-key part triples when
// URI-encoded.
const LONGEST_ROUTE_ID = ':a'.repeat(64);
const LONGEST_SESSION_IDS = [`${'s'.repeat(127)}1`, `${'s'.repeat(127)}2`] as const;

describe('RTC topology work codec', () => {
    it('an rtt-refresh work\'s execution id and publication id stay within the shared 256-character id cap', () => {
        const group = toLongestScope(createRtcTopologyGroupSnapshot(LONGEST_ROUTE_ID, LONGEST_SESSION_IDS));
        const envelope = readRttRefreshEnvelope(group, `sha256:${'f'.repeat(64)}`);
        const workId = toRtcTopologyExecutionId(envelope, Number.MAX_SAFE_INTEGER);
        const publicationId = toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: {
                groupRevision: Number.MAX_SAFE_INTEGER,
                presenceRevision: Number.MAX_SAFE_INTEGER
            },
            overlayVersion: Number.MAX_SAFE_INTEGER
        });

        expect(envelope.resourceId.length).toBeGreaterThan(346);
        expect(isAdminTopologyOutboxId(workId)).toBe(true);
        expect(isAdminTopologyOutboxId(publicationId)).toBe(true);
        expect(workId).toMatch(/^[0-9a-f]{64}:9007199254740991:0$/u);
    });

    it('a coalesced group-revision work\'s execution id and publication id stay within the cap at the largest generation', () => {
        const group = toLongestScope(createRtcTopologyGroupSnapshot(LONGEST_ROUTE_ID, LONGEST_SESSION_IDS));
        const envelope = readGroupRevisionEnvelope(group, Number.MAX_SAFE_INTEGER);
        const workId = toRtcTopologyExecutionId(envelope, Number.MAX_SAFE_INTEGER);
        const publicationId = toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: {
                groupRevision: Number.MAX_SAFE_INTEGER,
                presenceRevision: Number.MAX_SAFE_INTEGER
            },
            overlayVersion: Number.MAX_SAFE_INTEGER
        });

        expect(isAdminTopologyOutboxId(workId)).toBe(true);
        expect(isAdminTopologyOutboxId(publicationId)).toBe(true);
        expect(workId).toMatch(/^[0-9a-f]{64}:9007199254740991:9007199254740991$/u);
    });

    it('two works that differ only in their resource id get different execution ids', () => {
        const group = createRtcTopologyGroupSnapshot('group-1', ['peer-1', 'peer-2']);
        const first = readRttRefreshEnvelope(group, `sha256:${'a'.repeat(64)}`);
        const second = readRttRefreshEnvelope(group, `sha256:${'b'.repeat(64)}`);

        expect(toRtcTopologyExecutionId(first, 1_000)).not.toBe(toRtcTopologyExecutionId(second, 1_000));
    });

    it('a digest publication id round-trips through its publication storage key', () => {
        const group = toLongestScope(createRtcTopologyGroupSnapshot(LONGEST_ROUTE_ID, LONGEST_SESSION_IDS));
        const workId = toRtcTopologyExecutionId(
            readRttRefreshEnvelope(group, `sha256:${'f'.repeat(64)}`),
            1_000
        );
        const publicationId = toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: group.causalRevision,
            overlayVersion: 1
        });

        expect(decodeChildKey(childKey(group.group, 'publication', publicationId), 'publication')).toEqual({
            groupRef: {
                applicationId: LONGEST_ROUTE_ID,
                workspaceId: LONGEST_ROUTE_ID,
                groupId: LONGEST_ROUTE_ID
            },
            value: publicationId
        });
    });
});

function toLongestScope(group: GroupSnapshot): GroupSnapshot {
    const scope = { applicationId: LONGEST_ROUTE_ID, workspaceId: LONGEST_ROUTE_ID };
    return {
        ...group,
        group: { ...group.group, ...scope },
        members: group.members.map((member) => ({ ...member, ...scope })),
        activeSessions: group.activeSessions.map((session) => ({ ...session, ...scope }))
    };
}

function readRttRefreshEnvelope(group: GroupSnapshot, commandHash: string) {
    const [sessionIdFrom, sessionIdTo] = group.activeSessions.map((session) => session.sessionId);
    const rtt = createRtcTopologyRttMeasurement({
        sessionIdFrom: sessionIdFrom!,
        sessionIdTo: sessionIdTo!,
        rttMs: 40,
        version: Number.MAX_SAFE_INTEGER
    });
    const receiptId = toRtcRttMutationReceiptId(rtt);
    const resourceId = toRtcRttTopologyOutboxId(receiptId, group.group, commandHash);
    const entry = computeRtcTopologyOutboxInsert({
        traceId: 'trace-rtc-topology-work-codec',
        commandId: resourceId,
        aggregateRef: group.group,
        acceptedCausalRevision: group.causalRevision,
        groupSnapshot: group,
        effectKind: 'rtc-topology-recompute',
        createdAtEpochMs: 1_000,
        expireAtEpochMs: 4_102_444_800_000,
        senderId: 'topology-service',
        resourceId,
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true,
        payloadKind: 'rtt-refresh',
        rtt,
        refinementObservationId: receiptId
    }).entry;
    return readRtcTopologyWorkEnvelope(decodePersistedALMessage(entry.resource), AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);
}

function readGroupRevisionEnvelope(group: GroupSnapshot, generation: number) {
    const resourceId = `${'o'.repeat(100)}:group-revision`;
    const entry = computeRtcTopologyOutboxInsert({
        traceId: 'trace-rtc-topology-work-codec',
        commandId: resourceId,
        aggregateRef: group.group,
        acceptedCausalRevision: group.causalRevision,
        groupSnapshot: group,
        effectKind: 'rtc-topology-recompute',
        createdAtEpochMs: 1_000,
        expireAtEpochMs: 4_102_444_800_000,
        senderId: 'topology-service',
        resourceId,
        requestOptions: toCanonicalGroupTopologyConfigPatch({}),
        publish: true,
        payloadKind: 'group-revision',
        origin: 'automatic'
    }).entry;
    const message = JSON.parse(entry.resource) as { payload: { resource: string; }; };
    const envelope = JSON.parse(message.payload.resource) as { data: object; };
    envelope.data = {
        ...envelope.data,
        [COALESCED_APP_OUTBOX_WORK_FIELD]: {
            generation,
            requestedAtEpochMs: 1_000,
            windowOpenedAtEpochMs: 1_000,
            dueAtEpochMs: 2_000,
            reasons: ['membership']
        }
    };
    message.payload.resource = JSON.stringify(envelope);
    return readRtcTopologyWorkEnvelope(decodePersistedALMessage(JSON.stringify(message)), AppOutboxType.RTC_TOPOLOGY_RECOMPUTE);
}
