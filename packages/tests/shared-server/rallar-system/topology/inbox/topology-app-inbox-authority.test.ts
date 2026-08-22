import { describe, expect, it } from 'vitest';

import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-persistence-contracts.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { authSessionProofSecret } from '@shared-server/rallar-system/auth/sessions/auth-session-proof-secret.ts';
import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { AppInboxType } from '@shared-server/rallar-system/services/AppInboxService.ts';
import {
    constantTimeTopologyProofEqual,
    createAuthenticatedTopologyEnqueue,
    readTopologyAppInboxAuthority,
    verifyTopologyAppInboxAuthority
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts';
import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';

const NOW_EPOCH_MS = 1_000;
const ISSUED_SESSION: IssuedAuthSession = {
    clientId: 'owner',
    username: 'owner',
    sessionId: 'owner-session',
    accessToken: 'owner-access-token',
    issuedAtEpochMs: 500,
    expiresAtEpochMs: 2_000
};

describe('topology AppInbox authority', () => {
    it('binds enqueue authority to the current session and rechecks it on every attempt', async () => {
        let persistedSession: PersistedAuthSession | undefined = await toPersistedSession(ISSUED_SESSION);
        const groupStateService = sessionReader(() => persistedSession);
        const command = await topologyCommand();
        const enqueue = await createAuthenticatedTopologyEnqueue({
            enqueue: {
                type: AppInboxType.TOPOLOGY_CONFIG_PUT,
                resourceId: command.requestId,
                contextId: 'app-1:workspace-1:room-1',
                senderId: command.actor.principalId,
                data: command
            },
            claimedAuthority: ISSUED_SESSION,
            groupStateService,
            nowEpochMs: () => NOW_EPOCH_MS
        });
        const authority = readTopologyAppInboxAuthority(enqueue.authority);

        expect(authority).toMatchObject({
            kind: 'topology-config',
            command,
            proof: {
                principalId: ISSUED_SESSION.clientId,
                sessionId: ISSUED_SESSION.sessionId,
                sessionIssuedAtEpochMs: ISSUED_SESSION.issuedAtEpochMs,
                sessionExpiresAtEpochMs: ISSUED_SESSION.expiresAtEpochMs,
                commandHash: command.commandHash
            }
        });
        expect(JSON.stringify(authority)).not.toContain(ISSUED_SESSION.accessToken);
        await expect(
            verifyTopologyAppInboxAuthority({
                authority,
                groupStateService,
                nowEpochMs: () => NOW_EPOCH_MS
            })
        ).resolves.toBeUndefined();

        persistedSession = undefined;
        await expect(
            verifyTopologyAppInboxAuthority({
                authority,
                groupStateService,
                nowEpochMs: () => NOW_EPOCH_MS
            })
        ).rejects.toThrow(/missing, expired, revoked, or mismatched/i);
    });

    it('rejects proof, command-hash, and durable authority corruption', async () => {
        const persistedSession = await toPersistedSession(ISSUED_SESSION);
        const groupStateService = sessionReader(() => persistedSession);
        const command = await topologyCommand();
        const prepared = await createAuthenticatedTopologyEnqueue({
            enqueue: {
                type: AppInboxType.TOPOLOGY_CONFIG_PUT,
                resourceId: command.requestId,
                data: command
            },
            claimedAuthority: ISSUED_SESSION,
            groupStateService,
            nowEpochMs: () => NOW_EPOCH_MS
        });
        const authority = readTopologyAppInboxAuthority(prepared.authority);

        await expect(
            verifyTopologyAppInboxAuthority({
                authority: {
                    ...authority,
                    proof: { ...authority.proof, commandMac: `${authority.proof.commandMac}0` }
                },
                groupStateService,
                nowEpochMs: () => NOW_EPOCH_MS
            })
        ).rejects.toThrow(/proof does not match/i);
        await expect(
            verifyTopologyAppInboxAuthority({
                authority: {
                    ...authority,
                    command: {
                        ...authority.command,
                        requestId: `${authority.command.requestId}-tampered`
                    }
                },
                groupStateService,
                nowEpochMs: () => NOW_EPOCH_MS
            })
        ).rejects.toThrow(/command hash is invalid/i);
        expect(() => readTopologyAppInboxAuthority({ ...authority, unexpected: true })).toThrow(
            /durable authority is malformed/i
        );
    });

    it('compares equal proofs and rejects first, last, and length differences', () => {
        expect(constantTimeTopologyProofEqual('proof-value', 'proof-value')).toBe(true);
        expect(constantTimeTopologyProofEqual('proof-value', 'xroof-value')).toBe(false);
        expect(constantTimeTopologyProofEqual('proof-value', 'proof-valuf')).toBe(false);
        expect(constantTimeTopologyProofEqual('proof-value', 'proof-value-longer')).toBe(false);
    });
});

async function topologyCommand() {
    return await toTopologyAppInboxCommand({
        actor: { principalId: ISSUED_SESSION.clientId, sessionId: ISSUED_SESSION.sessionId },
        groupRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        },
        requestId: 'authority-request',
        capturedAtEpochMs: NOW_EPOCH_MS,
        payload: { operation: 'putConfig', config: { topologyKind: 'tree' } }
    });
}

async function toPersistedSession(session: IssuedAuthSession): Promise<PersistedAuthSession> {
    return {
        clientId: session.clientId,
        username: session.username,
        sessionId: session.sessionId,
        accessTokenDigest: await authSessionProofSecret(session),
        issuedAtEpochMs: session.issuedAtEpochMs,
        expiresAtEpochMs: session.expiresAtEpochMs
    };
}

function sessionReader(read: () => PersistedAuthSession | undefined): GroupStateService {
    return {
        readIssuedAuthSession: () => Promise.resolve(read())
    } as unknown as GroupStateService;
}
