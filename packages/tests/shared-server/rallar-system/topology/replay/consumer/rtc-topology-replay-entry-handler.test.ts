import type { RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import { RtcTopologyReplayEntryHandlerService } from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.ts';
import { RtcTopologyDeliveryCorruptionError } from '@shared-server/rallar-system/topology/replay/delivery/rtc-topology-delivery-validation.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, vi } from 'vitest';

import { createRtcTopologyReplayFixture } from './rtc-topology-replay-fixture.ts';

describe('RtcTopologyReplayEntryHandlerService', () => {
    it('delivers the exact immutable outbox message when the publication is current', async () => {
        const fixture = createRtcTopologyReplayFixture();
        const { handler, send } = createHandler(fixture);

        await expect(
            handler.handle(fixture.entry, fixture.databaseNowEpochMs, new AbortController().signal)
        ).resolves.toEqual({ status: 'delivered' });
        expect(send).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith(JSON.parse(fixture.outbox.resource));
    });

    it('materializes a fixed-audience current-state repair for stale history', async () => {
        const fixture = createRtcTopologyReplayFixture();
        const currentSnapshot = {
            ...fixture.currentSnapshot,
            activeSessionIds: ['session-2'],
            nextHopsBySessionId: { 'session-2': [] },
            version: fixture.currentSnapshot.version + 1,
            updatedAtEpochMs: fixture.currentSnapshot.updatedAtEpochMs + 1
        };
        const { handler, send } = createHandler({ ...fixture, currentSnapshot });

        await expect(
            handler.handle(fixture.entry, fixture.databaseNowEpochMs, new AbortController().signal)
        ).resolves.toEqual({ status: 'current-repair' });
        const message = send.mock.calls[0]![0];
        expect(message.payload.resource).toBe(JSON.stringify(currentSnapshot));
        expect(message.route).toEqual({
            topicId: AppTopics.overlayTopology,
            contextId: fixture.entry.groupRef.groupId,
            resourceId: `${currentSnapshot.overlayId}:` +
                `${currentSnapshot.sourceGroupStateCausalRevision.groupRevision}:` +
                `${currentSnapshot.sourceGroupStateCausalRevision.presenceRevision}:` +
                `${currentSnapshot.version}`
        });
        expect(message.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: fixture.entry.groupRef,
            recipientPeerIds: ['session-2']
        });
        expect(message.constraints?.expiresAtMs).toBe(fixture.entry.retainUntilEpochMs);
    });

    it('treats no current local recipient as successful handling', async () => {
        const fixture = createRtcTopologyReplayFixture();
        const { handler } = createHandler(fixture, 'no-recipients');

        await expect(
            handler.handle(fixture.entry, fixture.databaseNowEpochMs, new AbortController().signal)
        ).resolves.toEqual({ status: 'no-local-recipient' });
    });

    it.each(['partial-failure', 'failed'] as const)(
        'stops the contiguous replay predecessor on %s',
        async (sendStatus) => {
            const fixture = createRtcTopologyReplayFixture();
            const { handler } = createHandler(fixture, sendStatus);

            await expect(
                handler.handle(fixture.entry, fixture.databaseNowEpochMs, new AbortController().signal)
            ).resolves.toEqual({ status: 'send-failed' });
        }
    );

    it('returns a typed retention gap without attempting a send', async () => {
        const fixture = createRtcTopologyReplayFixture();
        const { handler, send } = createHandler({ ...fixture, publication: undefined, outbox: undefined });

        await expect(
            handler.handle(
                fixture.entry,
                fixture.entry.retainUntilEpochMs,
                new AbortController().signal
            )
        ).resolves.toEqual({ status: 'gap' });
        expect(send).not.toHaveBeenCalled();
    });

    it('propagates corruption for a missing unexpired durable reference', async () => {
        const fixture = createRtcTopologyReplayFixture();
        const { handler, send } = createHandler({ ...fixture, outbox: undefined });

        await expect(
            handler.handle(fixture.entry, fixture.databaseNowEpochMs, new AbortController().signal)
        ).rejects.toBeInstanceOf(RtcTopologyDeliveryCorruptionError);
        expect(send).not.toHaveBeenCalled();
    });
});

type Fixture = ReturnType<typeof createRtcTopologyReplayFixture>;

function createHandler(
    fixture:
        & Omit<Fixture, 'publication' | 'outbox'>
        & Readonly<{
            publication?: RtcTopologyPublication;
            outbox?: ResourceEntry;
        }>,
    sendStatus: 'sent-live' | 'no-recipients' | 'partial-failure' | 'failed' = 'sent-live'
) {
    const send = vi.fn((_message: ALMessage) => ({ status: sendStatus }));
    return {
        handler: new RtcTopologyReplayEntryHandlerService({
            publications: {
                findPublication: vi.fn(async () => fixture.publication)
            },
            outbox: {
                getItem: vi.fn(async () => fixture.outbox)
            },
            snapshots: {
                findSnapshot: vi.fn(async () => fixture.currentSnapshot)
            },
            sender: { sendToTargetsWithResult: send }
        }),
        send
    };
}
