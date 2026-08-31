import '../../setup-browser-indexeddb.ts';

import { configureBrowserALRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toResilienceDto } from '@shared-web/browser/resilience-config.ts';
import { initialiseRtcOverlayMulticastManager } from '@shared-web/browser/rtc/initialise-browser-rtc-runtime.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { setAcceptedOverlayById, setPlannedOverlayById } from '@shared/repository/overlays-repository.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
// dprint-ignore
import {
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

describe('browser RTC runtime composition', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        configureBrowserALRuntimeStores('self');
    });

    it('routes multicast traffic through accepted rather than conflicting planned next hops', async () => {
        const group = createGroupSnapshotFixture({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            sessionIds: ['self', 'accepted-peer', 'planned-peer']
        });
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const overlayId = toScopedOverlayId(group.group);
        setPlannedOverlayById(
            overlayId,
            overlay(group, 2, ['planned-peer'])
        );
        setAcceptedOverlayById(
            overlayId,
            overlay(group, 1, ['accepted-peer'])
        );
        const acceptedChannel = openRtcChannel();
        const plannedChannel = openRtcChannel();
        const connectionService = {
            input: { sessionId: 'self' },
            readyPeerIdsForLane: () => ['accepted-peer', 'planned-peer'],
            readPeer: (peerId: string) => ({
                channel: peerId === 'accepted-peer' ? acceptedChannel : plannedChannel
            })
        };
        const manager = initialiseRtcOverlayMulticastManager({
            webRtcConnectionService: connectionService as never,
            qboxEngine: new InboxOutboxEngine(),
            resilience: toResilienceDto()
        });

        const result = await manager.enqueueIfAbsent(
            newALMulticastMessage(
                'self',
                {
                    topicId: 'chat',
                    resourceId: 'message-1',
                    contextId: group.group.groupId
                },
                group.group,
                'chat.message.v1',
                { text: 'accepted traffic only' },
                {
                    qos: {
                        durability: { algo: 'volatile' }
                    }
                }
            )
        );

        expect(result).toMatchObject({ status: 'sent-immediate', entries: [] });
        expect(acceptedChannel.sentMessages).toHaveLength(1);
        expect(plannedChannel.sentMessages).toEqual([]);
        const sent = acceptedChannel.sentMessages[0];
        expect(sent?.forwarding?.overlayId).toBe(overlayId);
        expect(sent?.forwarding?.nextHopPeerIds).toEqual(['accepted-peer']);
    });
});

interface TestRtcChannel {
    readonly sentMessages: ALMessage[];
    readonly send: (message: ALMessage) => Promise<void>;
    readonly readHealth: () => { readonly readyState: 'open'; };
}

function openRtcChannel(): TestRtcChannel {
    const sentMessages: ALMessage[] = [];
    return {
        sentMessages,
        send: async (message) => {
            sentMessages.push(message);
        },
        readHealth: () => ({ readyState: 'open' })
    };
}

function overlay(
    group: GroupSnapshot,
    version: number,
    nextHopSessionIds: readonly string[]
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: group.causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree',
        name: group.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: [...nextHopSessionIds],
        degreeLimit: 5,
        overlayVersion: version,
        updatedAtEpochMs: version
    };
}
