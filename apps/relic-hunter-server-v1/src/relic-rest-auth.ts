import { canUpdateGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-governance-policy.ts';
import { canSendGroupMessage } from '@shared-server/rallar-system/group-state/policy/group-message-policy.ts';
import { GroupPolicyDeniedError } from '@shared-server/rallar-system/group-state/policy/group-policy-result.ts';
import { canReadGroupSnapshot } from '@shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RelicCommandSender } from './apply-relic-ws-command.ts';
import type { RelicRestAuthorizationMode } from './relic-hunter-server-configuration.ts';

type RelicRestAuthInput = Readonly<{
    mode: RelicRestAuthorizationMode;
    gameId: string;
    session: RelicCommandSender;
    snapshot?: GroupSnapshot;
}>;

export class RelicRestGroupNotFoundError extends Error {
    public override readonly name = 'RelicRestGroupNotFoundError';
    public readonly status = 404;

    public constructor(gameId: string) {
        super(`Relic group not found: ${gameId}`);
    }
}

export function authorizeRelicSnapshotRead(input: RelicRestAuthInput): void {
    if (input.mode === 'authenticated') {
        return;
    }

    const result = canReadGroupSnapshot({
        snapshot: requireRelicGroupSnapshot(input),
        actor: actorFromSession(input.session)
    });
    if (!result.allowed) {
        throw new GroupPolicyDeniedError(result);
    }
}

export function authorizeRelicCommand(input: RelicRestAuthInput): void {
    if (input.mode === 'authenticated') {
        return;
    }

    const result = canSendGroupMessage({
        snapshot: requireRelicGroupSnapshot(input),
        actor: actorFromSession(input.session),
        senderSessionId: input.session.sessionId
    });
    if (!result.allowed) {
        throw new GroupPolicyDeniedError(result);
    }
}

export function authorizeRelicReset(input: RelicRestAuthInput): void {
    if (input.mode === 'authenticated') {
        return;
    }

    const result = canUpdateGroupSnapshot({
        snapshot: requireRelicGroupSnapshot(input),
        actor: actorFromSession(input.session)
    });
    if (!result.allowed) {
        throw new GroupPolicyDeniedError(result);
    }
}

function requireRelicGroupSnapshot(input: RelicRestAuthInput): GroupSnapshot {
    if (!input.snapshot) {
        throw new RelicRestGroupNotFoundError(input.gameId);
    }

    return input.snapshot;
}

function actorFromSession(session: RelicCommandSender) {
    return {
        principalId: session.clientId,
        sessionId: session.sessionId
    };
}
