import { RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository.ts';
import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { computeRtcTopologyPublicationOutbox } from '@shared-server/rallar-system/topology/publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyReplayDiagnosticsEvent } from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-diagnostics.ts';
import { RtcTopologyReplayEntryHandlerService } from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.ts';
import { RtcTopologyReplayPageProcessor } from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-page-processor.ts';
import type { RtcTopologyDeliveryLogEntry } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-contracts.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    describe,
    expect,
    it
} from 'vitest';

import { FakeRuntimeStateRepository } from '../../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import {
    createGroupRef,
    createPublication,
    createTopologySnapshot
} from '../../rtc-topology-repository-test-fixtures.ts';

const PUBLISHER_STREAM_ID = '00000000-0000-4000-8000-000000000007';
const DATABASE_NOW_EPOCH_MS = 100;

describe('RtcTopologyReplayPageProcessor', () => {
    it('advances past a pre-v4 publication row as a gap, re-hydrates, and moves the cursor over the later v4 rows', async () => {
        const replay = await createReplayPage('pre-v4');

        await expect(replay.processor.process(replay.input)).resolves.toBe('done');

        expect(replay.timeline).toEqual(['cursor 0 -> 1', 'hydrate', 'cursor 1 -> 3']);
        expect(replay.sent.length).toBeGreaterThan(0);
        expect(replay.diagnostics).toEqual([
            { kind: 'entry', outcome: 'current-repair' },
            { kind: 'cursor', outcome: 'gap' },
            { kind: 'cursor', outcome: 'advanced' },
            { kind: 'cursor', outcome: 'advanced' }
        ]);
    });

    it('stalls on a malformed v4 publication row as corruption without hydrating', async () => {
        const replay = await createReplayPage('malformed-v4');

        await expect(replay.processor.process(replay.input)).resolves.toBe('failed');

        expect(replay.timeline).toEqual(['cursor 0 -> 1']);
        expect(replay.diagnostics).toEqual([
            { kind: 'entry', outcome: 'current-repair' },
            { kind: 'cursor', outcome: 'advanced' }
        ]);
    });
});

async function createReplayPage(secondRow: 'pre-v4' | 'malformed-v4') {
    const runtimeRepository = new FakeRuntimeStateRepository();
    const publications = new RtcTopologyPublicationRepository(runtimeRepository);
    const groupRef = createGroupRef();
    const rows = [1, 2, 3].map((version) => createPublication(createTopologySnapshot(groupRef, version), `work-${version}`));
    const outbox = rows.flatMap((publication) => computeRtcTopologyPublicationOutbox(publication));
    for (const [index, publication] of rows.entries()) {
        await runtimeRepository.upsert(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            publications.publicationKey(groupRef, publication.publicationId),
            JSON.stringify(index === 1 ? toStoredSecondRow(publication, secondRow) : publication),
            Date.now() + 60_000
        );
    }
    const sent: ALMessage[] = [];
    const timeline: string[] = [];
    const diagnostics: RtcTopologyReplayDiagnosticsEvent[] = [];
    const processor = new RtcTopologyReplayPageProcessor({
        consumerStreamId: '00000000-0000-4000-8000-000000000008',
        repository: {
            compareAndSetCursor: async ({ expectedSequence, nextSequence }) => {
                timeline.push(`cursor ${expectedSequence} -> ${nextSequence}`);
                return { status: 'advanced' };
            }
        },
        entryHandler: new RtcTopologyReplayEntryHandlerService({
            publications,
            outbox: { getItem: async (key) => outbox.find((page) => isKeysEqual(page.key, key)) },
            snapshots: { findSnapshot: async () => createTopologySnapshot(groupRef, 3) },
            acceptedSnapshots: { findSnapshot: async () => undefined },
            sender: {
                sendToTargetsWithResult: ({ message }) => {
                    sent.push(message);
                    return { status: 'sent-live' };
                }
            }
        }),
        hydrateGap: async () => {
            timeline.push('hydrate');
        },
        diagnostics: (event) => diagnostics.push(event)
    });
    const input: RtcTopologyReplayPageProcessor.Input = {
        result: {
            status: 'page',
            expectedCursorSequence: 0,
            entries: rows.map((publication, index) => toLogEntry(publication, outbox, index + 1)),
            hasMore: false,
            capturedHeadSequence: 3,
            retainedFromSequence: 1,
            databaseNowEpochMs: DATABASE_NOW_EPOCH_MS
        },
        publisherStreamId: PUBLISHER_STREAM_ID,
        signal: new AbortController().signal
    };
    return { processor, input, sent, timeline, diagnostics };
}

function toStoredSecondRow(publication: RtcTopologyPublication, secondRow: 'pre-v4' | 'malformed-v4') {
    if (secondRow === 'malformed-v4') {
        return { ...publication, traceId: 'not a trace' };
    }
    const { traceId: _traceId, ...preV4Row } = publication;
    return preV4Row;
}

function toLogEntry(
    publication: RtcTopologyPublication,
    outbox: readonly ResourceEntry[],
    sequence: number
): RtcTopologyDeliveryLogEntry {
    const firstPage = computeRtcTopologyPublicationOutbox(publication)[0];
    return {
        publisherStreamId: PUBLISHER_STREAM_ID,
        sequence,
        groupRef: publication.groupRef,
        publicationId: publication.publicationId,
        outboxKey: outbox.find((page) => isKeysEqual(page.key, firstPage.key))!.key,
        retainUntilEpochMs: publication.expiresAtEpochMs,
        insertedAtEpochMs: publication.createdAtEpochMs
    };
}
