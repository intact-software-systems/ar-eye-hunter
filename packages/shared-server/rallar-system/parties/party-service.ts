import type { PartyMutationResult } from '@shared/api/parties/party-request.ts';
import { decodePartyPolicy } from '@shared/api/parties/party-request.ts';
import type { PartyPolicy } from '@shared/api/parties/party.ts';
import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { AppInboxMessageContext } from '../app-inbox/app-inbox-contracts.ts';
import type { AuthSessionPersistence } from '../auth/persistence/auth-session-persistence.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import type { ClientPrincipalSnapshotRead } from '../client-state/persistence/client-state-persistence-contracts.ts';
import type { ClientStateRepository } from '../client-state/persistence/client-state-repository.ts';
import type { FriendsProfileRead } from '../friends/friends-mutation-contracts.ts';
import type { FriendsRepository } from '../friends/friends-repository.ts';
import { timeRallarAsync, type RallarTimingSink } from '../observability/timing.ts';
import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import { computePartyMutation, validatePartyMutation } from './compute-party-mutation.ts';
import type { PartyInvitationConsent } from './compute-party-roster.ts';
import { decodePartyCommand, decodePartyResult, type PartyCommand } from './party-command.ts';
import type { PartyRepository } from './persistence/party-repository.ts';
import { writePartyStorage } from './persistence/write-party-storage.ts';

export namespace PartyService {
    export interface Config {
        readonly defaultPolicy: PartyPolicy;
        readonly policiesByApplication: Readonly<Record<string, PartyPolicy>>;
    }
    export interface Dependencies {
        readonly appInbox: RallarServerAppInbox;
        readonly parties: PartyRepository;
        readonly profiles: Pick<FriendsRepository, 'readProfiles'>;
        readonly authSessions: Pick<AuthSessionPersistence, 'findSessionBySessionIdEntry'>;
        readonly clients: Pick<ClientStateRepository, 'readPrincipalSnapshot'>;
        readonly nowEpochMs: () => number;
        readonly timing: RallarTimingSink | undefined;
    }
    export interface Read {
        readonly command: PartyCommand;
        readonly party: PartyRepository.Read;
        readonly session: RuntimeStateEntryValue<PersistedAuthSession> | null;
        readonly profiles: readonly FriendsProfileRead[];
        readonly friendship: PartyInvitationConsent | null;
        readonly presence: readonly ClientPrincipalSnapshotRead[];
        readonly nowEpochMs: number;
    }
}

export class PartyService {
    readonly mutate: RallarServerAppInbox.Operation<PartyCommand, PartyMutationResult>;
    private readonly dependencies: PartyService.Dependencies;

    constructor(dependencies: PartyService.Dependencies, config: PartyService.Config) {
        this.dependencies = dependencies;
        this.mutate = dependencies.appInbox.register({
            type: 'app:rallar-parties:mutate',
            decodeEnvelope: ({ data }) => decodePartyCommand(data),
            encodeEnvelope: (command) => ({ data: decodeJsonWireValue(command, 'Party command') }),
            toBinding: (command) => ({
                contextId: computeSha256CanonicalJson({
                    applicationId: command.request.ref.applicationId,
                    workspaceId: command.request.ref.workspaceId,
                    principalId: command.principalId
                }),
                resourceId: command.requestId
            }),
            toLogicalCommand: (command) =>
                decodeJsonWireValue({ ...command, capturedAtEpochMs: null, policy: null }, 'Logical party command'),
            materialize: (command) => ({
                ...command,
                capturedAtEpochMs: dependencies.nowEpochMs(),
                policy: decodePartyPolicy(
                    Object.hasOwn(config.policiesByApplication, command.request.ref.applicationId)
                        ? config.policiesByApplication[command.request.ref.applicationId]
                        : config.defaultPolicy
                )
            }),
            encodeResult: (result) => decodeJsonWireValue(result, 'Party result'),
            decodeResult: decodePartyResult,
            handle: (command, context) => this.execute(command, context)
        });
    }

    private async execute(
        command: PartyCommand,
        context: AppInboxMessageContext<PartyMutationResult>
    ): Promise<PartyMutationResult> {
        const { timing, appInbox } = this.dependencies;
        const event = {
            component: 'parties',
            principalId: command.principalId,
            requestId: command.requestId,
            traceId: context.message.id.traceId,
            details: { attempt: context.entry.dequeueAudit.attempts }
        };
        const read = await timeRallarAsync(timing, { ...event, operation: 'read' }, () => this.read(command));
        const computed = await timeRallarAsync(
            timing,
            { ...event, operation: 'compute' },
            async () => computePartyMutation(read)
        );
        const issues = await timeRallarAsync(
            timing,
            { ...event, operation: 'validate' },
            async () => validatePartyMutation(read, computed)
        );
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
        return await timeRallarAsync(
            timing,
            { ...event, operation: 'commit' },
            () =>
                appInbox.commit(
                    context,
                    computed.result,
                    (transaction) =>
                        timeRallarAsync(timing, { ...event, operation: 'write' }, async () => {
                            if (computed.storage !== null) {
                                await writePartyStorage(transaction, computed.storage);
                            }
                        })
                )
        );
    }

    private async read(command: PartyCommand): Promise<PartyService.Read> {
        const { parties, authSessions, profiles, clients } = this.dependencies;
        const { ref, intent } = command.request;
        const principalIds = intent.action === 'invite'
            ? [command.principalId, intent.principalId]
            : [command.principalId];
        const [party, session] = await Promise.all([
            parties.read(ref, principalIds),
            authSessions.findSessionBySessionIdEntry(command.sessionId)
        ]);
        const invitation = intent.action === 'accept'
            ? party.record?.invitations.find((entry) =>
                entry.invitationId === intent.invitationId && entry.principalId === command.principalId
            )
            : undefined;
        const pair = intent.action === 'invite'
            ? [command.principalId, intent.principalId]
            : invitation === undefined
            ? []
            : [invitation.senderPrincipalId, command.principalId];
        const presenceIds = intent.action === 'take-leadership'
            ? party.record?.members.map((member) => member.principalId) ?? []
            : intent.action === 'create' || intent.action === 'accept'
            ? [command.principalId]
            : [];
        const [consent, presenceReads] = await Promise.all([
            pair.length === 0 ? Promise.resolve([]) : profiles.readProfiles(pair),
            Promise.all(presenceIds.map((principalId) =>
                clients.readPrincipalSnapshot({
                    applicationId: ref.applicationId,
                    workspaceId: ref.workspaceId,
                    principalId
                })
            ))
        ]);
        if (intent.action === 'take-leadership' && presenceReads.some((entry) => entry === undefined)) {
            throw new TypeError('Party member lost its durable scoped principal');
        }
        return {
            command,
            party,
            session: session ?? null,
            profiles: consent,
            friendship: consent.length === 0 ? null : {
                sender: consent[0]!.profile.contacts.find((contact) => contact.principalId === pair[1])?.status ?? null,
                recipient: consent[1]!.profile.contacts.find((contact) => contact.principalId === pair[0])?.status ??
                    null
            },
            presence: presenceReads.filter((entry): entry is ClientPrincipalSnapshotRead => entry !== undefined),
            nowEpochMs: Math.max(this.dependencies.nowEpochMs(), command.capturedAtEpochMs ?? 0)
        };
    }
}
