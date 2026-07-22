import { describe, expect, it } from 'vitest';

import {
    toTopologyAppInboxCommand,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
    serializeCanonicalJsonWire,
    toJsonWireAppInboxEnqueue,
    toLogicalAppInboxCommand,
} from '@shared-server/rallar-system/services/app-inbox-command-wire.ts';

describe('topology AppInbox durable command contract', () => {
    it('keeps HTTP topology identity stable across retry clocks and durable preparation changes', async () => {
        const first = await topologyCommand(1_000);
        const replay = await topologyCommand(9_000);
        expect(replay.commandHash).toBe(first.commandHash);

        const firstIdentity = logicalIdentity({
            type: AppInboxType.TOPOLOGY_CONFIG_PUT,
            resourceId: first.requestId,
            data: first,
            authority: {
                kind: 'topology-config',
                proof: { commandHash: first.commandHash, commandMac: 'first' },
                preparation: { mutableDeleteTarget: 'first' },
            },
        });
        const replayIdentity = logicalIdentity({
            type: AppInboxType.TOPOLOGY_CONFIG_PUT,
            resourceId: replay.requestId,
            data: replay,
            authority: {
                kind: 'topology-config',
                proof: { commandHash: replay.commandHash, commandMac: 'second' },
                preparation: { mutableDeleteTarget: 'second' },
            },
        });
        expect(replayIdentity).toBe(firstIdentity);
    });

    it('collides divergent stable topology semantics behind the same request id', async () => {
        const first = await topologyCommand(1_000);
        const divergent = await toTopologyAppInboxCommand({
            actor: first.actor,
            groupRef: first.groupRef,
            requestId: first.requestId,
            capturedAtEpochMs: 2_000,
            payload: {
                operation: 'putConfig',
                config: { topologyKind: 'mesh' },
            },
        });

        expect(divergent.commandHash).not.toBe(first.commandHash);
        expect(logicalIdentity({
            type: AppInboxType.TOPOLOGY_CONFIG_PUT,
            resourceId: first.requestId,
            data: first,
        })).not.toBe(logicalIdentity({
            type: AppInboxType.TOPOLOGY_CONFIG_PUT,
            resourceId: divergent.requestId,
            data: divergent,
        }));
    });

    it('rejects unknown sparse request keys before durable enqueue', async () => {
        await expect(toTopologyAppInboxCommand({
            actor: { principalId: 'owner', sessionId: 'owner-session' },
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            requestId: 'topology-request-1',
            capturedAtEpochMs: 1_000,
            payload: {
                operation: 'putConfig',
                config: {
                    topologyKind: 'tree',
                    unexpected: true,
                },
            } as never,
        })).rejects.toThrow(/unknown|canonical|invalid/i);
    });
});

async function topologyCommand(capturedAtEpochMs: number) {
    return await toTopologyAppInboxCommand({
        actor: { principalId: 'owner', sessionId: 'owner-session' },
        groupRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1',
        },
        requestId: 'topology-request-1',
        capturedAtEpochMs,
        payload: {
            operation: 'putConfig',
            config: { topologyKind: 'tree' },
        },
    });
}

function logicalIdentity(enqueue: Parameters<
    typeof toJsonWireAppInboxEnqueue
>[0]): string {
    return serializeCanonicalJsonWire(
        toLogicalAppInboxCommand(toJsonWireAppInboxEnqueue(enqueue)),
    );
}
