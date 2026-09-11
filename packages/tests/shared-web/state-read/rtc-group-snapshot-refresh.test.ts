import { describe, expect, it, vi } from 'vitest';

import { RtcGroupSnapshotRefresh } from '@shared-web/browser/state-read/rtc-group-snapshot-refresh.ts';
import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';

const roomRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

describe('RTC group-snapshot refresh', () => {
    it('requests authoritative refresh through the message snapshot floor', async () => {
        const refreshGroupSnapshot = vi.fn(async () => undefined);
        const refresh = new RtcGroupSnapshotRefresh({
            refreshGroupSnapshot
        });
        const message = roomMessage(6);

        await refresh.afterInboundAdmission(
            message,
            { kind: 'not-admitted', reason: 'not-yet-in-sync' }
        );

        expect(refreshGroupSnapshot).toHaveBeenCalledWith(
            roomRef,
            6,
            expect.any(AbortSignal)
        );
    });

    it('does not read authority after successful admission', async () => {
        const refreshGroupSnapshot = vi.fn(async () => undefined);
        const refresh = new RtcGroupSnapshotRefresh({
            refreshGroupSnapshot
        });

        await refresh.afterInboundAdmission(roomMessage(6), { kind: 'admitted' });

        expect(refreshGroupSnapshot).not.toHaveBeenCalled();
    });

    it('coalesces repeated recovery requests for the same group and snapshot floor', async () => {
        const response = Promise.withResolvers<void>();
        const refreshGroupSnapshot = vi.fn(() => response.promise);
        const refresh = new RtcGroupSnapshotRefresh({
            refreshGroupSnapshot
        });
        const message = roomMessage(6);
        const acceptance = { kind: 'not-admitted' as const, reason: 'not-yet-in-sync' };

        const first = refresh.afterInboundAdmission(message, acceptance);
        const second = refresh.afterInboundAdmission(message, acceptance);
        response.resolve();
        await Promise.all([first, second]);

        expect(refreshGroupSnapshot).toHaveBeenCalledOnce();
    });

    it('leaves failed refreshes to the retained QueueBox retry', async () => {
        const refreshGroupSnapshot = vi.fn()
            .mockRejectedValueOnce(new Error('point read failed'))
            .mockResolvedValueOnce(undefined);
        const refresh = new RtcGroupSnapshotRefresh({ refreshGroupSnapshot });
        const message = roomMessage(6);
        const acceptance = { kind: 'not-admitted' as const, reason: 'not-yet-in-sync' };

        await expect(refresh.afterInboundAdmission(message, acceptance)).resolves.toBeUndefined();
        await refresh.afterInboundAdmission(message, acceptance);

        expect(refreshGroupSnapshot).toHaveBeenCalledTimes(2);
    });

    it('aborts an active refresh and ignores later admissions after disposal', async () => {
        const response = Promise.withResolvers<void>();
        let refreshSignal: AbortSignal | undefined;
        let authorityAdopted = false;
        const requestedSnapshotVersions: number[] = [];
        const refreshGroupSnapshot = async (
            _roomRef: typeof roomRef,
            minSnapshotVersion: number,
            signal: AbortSignal
        ) => {
            requestedSnapshotVersions.push(minSnapshotVersion);
            refreshSignal = signal;
            await response.promise;
            signal.throwIfAborted();
            authorityAdopted = true;
        };
        const refresh = new RtcGroupSnapshotRefresh({ refreshGroupSnapshot });
        const acceptance = { kind: 'not-admitted' as const, reason: 'not-yet-in-sync' };

        const active = refresh.afterInboundAdmission(roomMessage(6), acceptance);
        await vi.waitFor(() => expect(refreshSignal).toBeDefined());
        refresh.dispose();
        response.resolve();
        await active;
        await refresh.afterInboundAdmission(roomMessage(7), acceptance);

        expect(refreshSignal?.aborted).toBe(true);
        expect(authorityAdopted).toBe(false);
        expect(requestedSnapshotVersions).toEqual([6]);
    });

    it('reads authority for a denial whose reason names the branch after the code', async () => {
        const refreshGroupSnapshot = vi.fn(async () => undefined);
        const refresh = new RtcGroupSnapshotRefresh({ refreshGroupSnapshot });

        await refresh.afterInboundAdmission(
            roomMessage(6),
            { kind: 'not-admitted', reason: 'not-yet-in-sync: Awaiting a room authority observation' }
        );

        expect(refreshGroupSnapshot).toHaveBeenCalledWith(roomRef, 6, expect.any(AbortSignal));
    });

    it('does not read authority after a denial the refresh cannot repair', async () => {
        const refreshGroupSnapshot = vi.fn(async () => undefined);
        const refresh = new RtcGroupSnapshotRefresh({ refreshGroupSnapshot });

        await refresh.afterInboundAdmission(roomMessage(6), { kind: 'not-admitted', reason: 'unauthorized' });

        expect(refreshGroupSnapshot).not.toHaveBeenCalled();
    });
});

function roomMessage(minSnapshotVersion: number) {
    return newALMulticastMessage(
        'sender',
        { topicId: 'room.chat', resourceId: 'message-1', contextId: roomRef.groupId },
        roomRef,
        'chat.message',
        { text: 'hello' },
        { minSnapshotVersion }
    );
}
