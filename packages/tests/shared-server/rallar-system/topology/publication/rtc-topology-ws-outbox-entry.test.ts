import { PGlite } from '@electric-sql/pglite';
import { Temporal } from '@js-temporal/polyfill';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ResourceInboxInvariantCorruptionError } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { toRtcTopologyPublicationId, toRtcTopologyPublicationMessageId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import {
    computeRtcTopologyPublicationOutbox,
    writeRtcTopologyPublicationOutbox
} from '@shared-server/rallar-system/topology/publication/rtc-topology-ws-outbox-entry.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

import { createPGliteSqlClient, type PGliteSql } from '../../../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';

describe('RTC topology publication WS outbox entry', () => {
    it('bounds its persistence key without changing the published AL route', () => {
        const publication = longRoutePublication();
        expect(publication.message.route.resourceId.length).toBeGreaterThan(128);

        const entry = computeRtcTopologyPublicationOutbox(publication).entry;
        const persistedMessage = decodePersistedALMessage(entry.resource);

        expect(entry.key).toEqual(toAppQueueKey({
            topicId: publication.message.route.topicId,
            resourceId: publication.message.id.msgId,
            contextId: publication.message.route.contextId
        }));
        expect(entry.key.resourceId.length).toBeLessThanOrEqual(36);
        expect(persistedMessage.route).toEqual(publication.message.route);
        expect(persistedMessage.targets).toMatchObject({ recipientPeerIds: publication.recipientSessionIds });
    });

    it('assigns distinct physical keys to publications sharing one logical route', () => {
        const first = longRoutePublication('topology-work-1');
        const second = longRoutePublication('topology-work-2');

        const entries = [first, second].map((publication) => computeRtcTopologyPublicationOutbox(publication).entry);
        const messages = entries.map((entry) => decodePersistedALMessage(entry.resource));

        expect(entries[0].key).not.toEqual(entries[1].key);
        expect(entries.every((entry) => entry.key.resourceId.length <= 36)).toBe(true);
        expect(messages[0].route).toEqual(messages[1].route);
        expect(messages[0].id.msgId).not.toBe(messages[1].id.msgId);
    });
});

describe('RTC topology publication outbox persistence', () => {
    let database: PGliteSql;

    beforeEach(async () => {
        database = createPGliteSqlClient(new PGlite());
        await database.exec(readFileSync(new URL('../../../../../../apps/api-v1/src/db/in-memory-schema.sql', import.meta.url), 'utf8'));
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await database.close();
    });

    it('inserts and replays computed publication bytes without formatting candidate timestamps in the transaction', async () => {
        const computed = computeRtcTopologyPublicationOutbox(longRoutePublication());
        const formatting = vi.spyOn(Temporal.PlainDateTime.prototype, 'toString').mockImplementation(() => {
            throw new Error('Candidate timestamp formatting ran in the write');
        });

        await database.begin(async (transaction) => {
            await writeRtcTopologyPublicationOutbox(transaction, computed);
        });
        const before = await database`select * from resource_inbox`;
        await database.begin(async (transaction) => {
            await writeRtcTopologyPublicationOutbox(transaction, computed);
        });

        expect(before).toHaveLength(1);
        expect(await database`select * from resource_inbox`).toEqual(before);
    });

    it('replays a valid completed row without replacing its lifecycle', async () => {
        const computed = computeRtcTopologyPublicationOutbox(longRoutePublication());
        await database.begin(async (transaction) => {
            await writeRtcTopologyPublicationOutbox(transaction, computed);
        });
        await database`
            update resource_inbox
            set ri_status = 'COMPLETED', ri_attempts = 1,
                start_ts = '1970-01-01 00:00:01.100', end_ts = '1970-01-01 00:00:01.200'
        `;
        const before = await database`select * from resource_inbox`;

        await database.begin(async (transaction) => {
            await writeRtcTopologyPublicationOutbox(transaction, computed);
        });

        expect(await database`select * from resource_inbox`).toEqual(before);
    });

    it.each(['immutable content', 'lifecycle'] as const)('rejects conflicting %s and rolls back a preceding insert', async (defect) => {
        const existing = computeRtcTopologyPublicationOutbox(longRoutePublication('existing-publication'));
        const preceding = computeRtcTopologyPublicationOutbox(longRoutePublication('preceding-publication'));
        await database.begin(async (transaction) => {
            await writeRtcTopologyPublicationOutbox(transaction, existing);
        });
        if (defect === 'immutable content') {
            await database`update resource_inbox set ri_resource = 'different bytes'`;
        }
        else {
            await database`update resource_inbox set ri_status = 'COMPLETED', ri_attempts = 0`;
        }
        const before = await database`select * from resource_inbox`;

        await expect(database.begin(async (transaction) => {
            await writeRtcTopologyPublicationOutbox(transaction, preceding);
            await writeRtcTopologyPublicationOutbox(transaction, existing);
        })).rejects.toBeInstanceOf(ResourceInboxInvariantCorruptionError);

        expect(await database`select * from resource_inbox`).toEqual(before);
    });
});

function longRoutePublication(workId = 'medium-scale-topology-work'): RtcTopologyPublication {
    const groupRef = {
        applicationId: 'medium-scale-application'.repeat(2),
        workspaceId: 'medium-scale-workspace'.repeat(2),
        groupId: 'medium-scale-group'.repeat(2)
    };
    const causalRevision = { groupRevision: 141, presenceRevision: 204 };
    const createdAtEpochMs = 1_000;
    const expiresAtMs = 2_000;
    const snapshot: RallarOverlayTopologySnapshot = {
        sourceGroupStateCausalRevision: causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(groupRef),
        groupRef,
        name: 'Medium-scale group',
        topology: 'tree',
        activeSessionIds: ['session-1'],
        nextHopsBySessionId: { 'session-1': [] },
        degreeLimit: 2,
        version: 122,
        createdByClientId: 'owner',
        createdAtEpochMs,
        updatedAtEpochMs: createdAtEpochMs
    };
    const message = {
        id: {
            v: 2 as const,
            msgId: toRtcTopologyPublicationMessageId(workId),
            ts: createdAtEpochMs,
            senderId: 'rallar-server'
        },
        route: {
            topicId: AppTopics.overlayTopology,
            resourceId: `${snapshot.overlayId}:${causalRevision.groupRevision}:` +
                `${causalRevision.presenceRevision}:${snapshot.version}`,
            contextId: groupRef.groupId
        },
        constraints: { expiresAtMs },
        targets: {
            mode: 'broadcast' as const,
            scope: 'room' as const,
            groupRef,
            minSnapshotVersion: 101
        },
        delivery: {
            reliability: 'best-effort' as const,
            ack: 'none' as const
        },
        payload: {
            typeId: AppTopics.overlayTopology,
            contentType: 'application/json' as const,
            resource: JSON.stringify(snapshot)
        },
        audit: { createdBy: 'rallar-server', createdTs: createdAtEpochMs }
    };
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: causalRevision,
            overlayVersion: snapshot.version
        }),
        workId,
        groupRef,
        sourceGroupStateCausalRevision: causalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: 101,
        recipientSessionIds: snapshot.activeSessionIds,
        message,
        createdAtEpochMs
    };
}
