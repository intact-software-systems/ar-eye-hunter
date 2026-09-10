import { describe, expect, it, vi } from 'vitest';

import { subscribeRoomTransportTarget } from '@shared-web/browser/rooms/room-transport-target-observation.ts';
import type { StateCacheChangeListener } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { OverlayRepositoryChangeListener } from '@shared/repository/overlays-repository.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};
const otherRoomRef: GroupRef = { ...roomRef, groupId: 'room-2' };

describe('room transport target observation', () => {
    it('wakes for the bound room snapshot and accepted slot only, then unsubscribes both sources', async () => {
        let onCacheChange: StateCacheChangeListener = () => undefined;
        let onAcceptedChange: OverlayRepositoryChangeListener = () => undefined;
        let stateSubscribed = true;
        let acceptedSubscribed = true;
        let wakeCount = 0;
        const unsubscribe = subscribeRoomTransportTarget(
            {
                room: roomRef,
                stateStore: {
                    onCacheChange: vi.fn((next) => {
                        onCacheChange = next;
                        return () => {
                            stateSubscribed = false;
                        };
                    }),
                    resolveRoomRef: vi.fn(() => roomRef)
                },
                slots: {
                    onAcceptedChange: vi.fn((next) => {
                        onAcceptedChange = next;
                        return () => {
                            acceptedSubscribed = false;
                        };
                    })
                }
            },
            () => {
                wakeCount += 1;
            }
        );

        await onCacheChange({
            clients: [],
            groups: [
                createGroupSnapshotFixture({
                    ...otherRoomRef,
                    sessionIds: ['session-1']
                })
            ]
        });
        await onAcceptedChange({
            kind: 'created',
            overlayId: toScopedOverlayId(otherRoomRef),
            version: 1
        });
        await onCacheChange({
            clients: [],
            groups: [
                createGroupSnapshotFixture({
                    ...roomRef,
                    sessionIds: ['session-1']
                })
            ]
        });
        await onAcceptedChange({
            kind: 'created',
            overlayId: toScopedOverlayId(roomRef),
            version: 1
        });
        unsubscribe();

        expect(wakeCount).toBe(2);
        expect(acceptedSubscribed).toBe(false);
        expect(stateSubscribed).toBe(false);
    });
});
