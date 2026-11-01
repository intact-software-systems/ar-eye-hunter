import type { FriendsMutationResult } from '@shared/api/friends/friends-request.ts';
import { timeRallarAsync, type RallarTimingSink } from '../observability/timing.ts';

import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import type { AppInboxMessageContext } from '../app-inbox/app-inbox-contracts.ts';
import type { AuthSessionPersistence } from '../auth/persistence/auth-session-persistence.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import { computeFriendsMutation, validateFriendsMutation } from './compute-friends-mutation.ts';
import type { FriendsAccountDirectory } from './friends-account-directory.ts';
import { decodeFriendsCommand, decodeFriendsResult } from './friends-command.ts';
import type { FriendsCommand, FriendsConfig, FriendsMutationRead } from './friends-mutation-contracts.ts';
import type { FriendsRepository } from './friends-repository.ts';
import { writeFriendsMutation } from './write-friends-mutation.ts';

export namespace FriendsService {
    export interface Dependencies {
        readonly timing: RallarTimingSink | undefined;
        readonly appInbox: RallarServerAppInbox;
        readonly profiles: FriendsRepository;
        readonly authSessions: Pick<AuthSessionPersistence, 'findSessionBySessionIdEntry'>;
        readonly accounts: FriendsAccountDirectory;
        readonly groups: Pick<GroupStateRepository, 'readSnapshotWithAuthorityGuard'>;
        readonly nowEpochMs: () => number;
    }
}

export class FriendsService {
    readonly mutate: RallarServerAppInbox.Operation<FriendsCommand, FriendsMutationResult>;
    private readonly dependencies: FriendsService.Dependencies;
    private readonly config: FriendsConfig;

    constructor(dependencies: FriendsService.Dependencies, config: FriendsConfig) {
        this.dependencies = dependencies;
        this.config = config;
        this.mutate = dependencies.appInbox.register({
            type: 'app:rallar-friends:mutate',
            decodeEnvelope: ({ data }) => decodeFriendsCommand(data),
            encodeEnvelope: (command) => ({ data: decodeJsonWireValue(command, 'Friends command') }),
            toBinding: (command) => ({
                contextId: computeSha256CanonicalJson(command.principalId),
                resourceId: command.requestId
            }),
            toLogicalCommand: (command) =>
                decodeJsonWireValue({ ...command, capturedAtEpochMs: null }, 'Logical friends command'),
            materialize: (command) => ({ ...command, capturedAtEpochMs: dependencies.nowEpochMs() }),
            encodeResult: (result) => ({ ...result }),
            decodeResult: decodeFriendsResult,
            handle: (command, context) => this.changeFriends(command, context)
        });
    }

    private async changeFriends(
        command: FriendsCommand,
        context: AppInboxMessageContext<FriendsMutationResult>
    ): Promise<FriendsMutationResult> {
        const timing = this.dependencies.timing;
        const event = {
            component: 'friends',
            principalId: command.principalId,
            requestId: command.requestId,
            traceId: context.message.id.traceId,
            details: { attempt: context.entry.dequeueAudit.attempts }
        };
        const read = await timeRallarAsync(timing, { ...event, operation: 'read' }, () => this.read(command));
        const computed = await timeRallarAsync(
            timing,
            { ...event, operation: 'compute' },
            async () => computeFriendsMutation(read)
        );
        const issues = await timeRallarAsync(
            timing,
            { ...event, operation: 'validate' },
            async () => validateFriendsMutation(computed)
        );
        if (issues[0] !== undefined) {
            throw new TypeError(issues[0]);
        }
        return await timeRallarAsync(
            timing,
            { ...event, operation: 'commit' },
            () =>
                this.dependencies.appInbox.commit(
                    context,
                    computed.result,
                    (transaction) =>
                        timeRallarAsync(timing, { ...event, operation: 'write' }, () =>
                            writeFriendsMutation(transaction, computed))
                )
        );
    }

    private async read(input: FriendsCommand): Promise<FriendsMutationRead> {
        const { accounts, profiles, authSessions, groups } = this.dependencies;
        const request = input.request;
        const account = request.action === 'request'
            ? await accounts.readByUsername(request.username)
            : 'principalId' in request
            ? await accounts.readByPrincipalId(request.principalId)
            : null;
        const targetId = account?.principalId ?? ('principalId' in request ? request.principalId : null);
        const [pair, session, destination] = await Promise.all([
            profiles.readProfiles(targetId === null ? [input.principalId] : [input.principalId, targetId]),
            authSessions.findSessionBySessionIdEntry(input.sessionId),
            request.action === 'invite' ? groups.readSnapshotWithAuthorityGuard(request.roomRef) : undefined
        ]);
        const nowEpochMs = this.dependencies.nowEpochMs();
        return {
            input,
            actor: pair[0]!,
            target: pair[1] ?? null,
            session: session ?? null,
            targetAvailable: account !== null,
            destination: destination ?? null,
            nowEpochMs,
            config: this.config
        };
    }
}
