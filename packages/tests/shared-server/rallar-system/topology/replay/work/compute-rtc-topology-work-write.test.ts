import { Temporal } from '@js-temporal/polyfill';
import { computeTopologyMutation } from '@shared-server/rallar-system/topology/mutation/rtc-topology-mutations.ts';
import {
    computeRtcTopologyWorkWrite,
    validateRtcTopologyWorkWrite,
    type AcceptedRtcTopologyWork,
    type ComputeRtcTopologyWorkWriteInput
} from '@shared-server/rallar-system/topology/replay/work/compute-rtc-topology-work-write.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';
import { createRtcTopologyGroupSnapshot } from '../../rtc-topology-test-fixtures.ts';

describe('RTC topology complete write computation', () => {
    it('rejects a write whose precomputed promotion request was removed', () => {
        const input = createWriteInput();
        const computed = computeRtcTopologyWorkWrite(input);
        if (computed.kind !== 'transaction' || computed.transaction.promotionRequest === null) {
            throw new Error('Expected a promotion transaction fixture');
        }
        const altered = {
            ...computed,
            transaction: {
                ...computed.transaction,
                promotionRequest: null
            }
        } as const;

        expect(() => validateRtcTopologyWorkWrite(input, altered)).toThrow(
            'RTC topology work write differs from its canonical computation'
        );
        expect(computeRtcTopologyWorkWrite(input)).toEqual(computed);
    });
});

function createWriteInput(): ComputeRtcTopologyWorkWriteInput {
    const group = createRtcTopologyGroupSnapshot('group-1', ['session-1']);
    const candidate: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision: group.causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        name: 'group-1',
        topology: 'star',
        activeSessionIds: ['session-1'],
        nextHopsBySessionId: { 'session-1': [] },
        degreeLimit: 5,
        version: 1,
        createdByClientId: 'session-1',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1
    };
    const mutationInput = {
        read: { snapshot: null, publicationClaim: null },
        candidate,
        publication: null,
        facts: {
            publicationExpireAtTimestamp: null,
            commandHash: null,
            attemptCount: null
        }
    } as const;
    const computed = computeTopologyMutation(mutationInput);
    if (computed.outcome === 'loaded' || computed.outcome === 'retry') {
        throw new Error('Expected an accepted topology mutation fixture');
    }
    const entry = createReservedEntry();
    const accepted: AcceptedRtcTopologyWork = {
        decision: 'accepted',
        work: {
            kind: 'group-revision',
            overlayId: candidate.overlayId,
            groupSnapshot: group,
            sourceGroupStateCausalRevision: group.causalRevision,
            requestedAtEpochMs: 1,
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            origin: 'automatic',
            publish: false
        },
        group,
        computed,
        mutationInput,
        publication: null,
        inputFingerprint: `sha256:${'a'.repeat(64)}`,
        promotionRead: { group: group.group, policy: { status: 'absent' } },
        criterionPetition: null
    };
    return {
        accepted,
        entry,
        reservationFinish: {
            key: entry.key,
            expectedAttempts: entry.dequeueAudit.attempts,
            status: EntityStatus.COMPLETED,
            completedAt: new Date('2026-01-02T03:05:00.000Z')
        },
        formationAutomationEnabled: false,
        serviceId: 'topology-service',
        publisherStreamId: undefined
    };
}

function createReservedEntry(): ResourceEntry {
    const createdTs = Temporal.PlainDateTime.from('2026-01-02T03:04:05');
    return {
        key: {
            topicId: 'rtc-topology',
            resourceId: 'work-1',
            contextId: 'group-1'
        },
        resource: '{"work":1}',
        typeId: 'APP_OUTBOX',
        status: EntityStatus.RESERVED,
        audit: {
            date: createdTs.toPlainTime(),
            createdBy: 'topology-service',
            createdTs,
            expiryTs: Temporal.Instant.from('2026-01-02T04:04:05Z')
        },
        dequeueAudit: { attempts: 2 }
    };
}
