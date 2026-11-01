import type { MatchmakingPolicy } from '@shared/api/matchmaking/matchmaking-policy.ts';
import type { MatchmakingMutationResult } from '@shared/api/matchmaking/matchmaking-request.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RallarServerAppInbox } from '../../rallar-server/rallar-server-app-inbox.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/runtime-state-json-store.ts';
import type { AppInboxCommandAttempt, AppInboxMessageContext } from '../app-inbox/app-inbox-contracts.ts';
import { toAppInboxCommandAttempt } from '../app-inbox/app-inbox-contracts.ts';
import type { AuthSessionPersistence } from '../auth/persistence/auth-session-persistence.ts';
import type { PersistedAuthSession } from '../auth/persistence/persisted-auth-session.ts';
import { validateComputedProjection } from '../computed-data-validation.ts';
import type { NewGroupCohortAdmissionInput } from '../group-state/mutation/membership/compute-group-cohort-admission.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import { timeRallarAsync, type RallarTimingSink } from '../observability/timing.ts';
import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import { decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import {
    computeMatchmakingMutation,
    validateMatchmakingMutation,
    writeMatchmakingMutation
} from './compute-matchmaking-mutation.ts';
import { computeMatchmaking } from './compute-matchmaking.ts';
import { readMatchmakingAdmission } from './matchmaking-admission.ts';
import { decodeMatchmakingCommand, decodeMatchmakingResult, type MatchmakingCommand } from './matchmaking-command.ts';
import { decodeMatchmakingDeadline, type MatchmakingDeadline } from './matchmaking-deadline.ts';
import type { MatchmakingFinished, MatchmakingProposal } from './matchmaking-pool.ts';
import { computeMatchmakingStorage, writeMatchmakingStorage } from './matchmaking-repository.ts';
import type { MatchmakingRepository } from './matchmaking-repository.ts';

export namespace MatchmakingService {
    export interface Config {
        readonly serviceId: string;
        readonly finishedRetentionMs: number;
        readonly defaultPolicy: MatchmakingPolicy;
        readonly policiesByApplication: Readonly<Record<string, MatchmakingPolicy>>;
    }

    export interface Dependencies {
        readonly appInbox: RallarServerAppInbox;
        readonly repository: MatchmakingRepository;
        readonly authSessions: Pick<AuthSessionPersistence, 'findSessionBySessionIdEntry'>;
        readonly groups: GroupStateRepository;
        readonly nowEpochMs: () => number;
        readonly timing: RallarTimingSink | undefined;
    }

    export interface Read {
        readonly command: MatchmakingCommand;
        readonly attempt: AppInboxCommandAttempt;
        readonly nowEpochMs: number;
        readonly pool: MatchmakingRepository.Read;
        readonly finished: MatchmakingFinished | null;
        readonly sessions: readonly RuntimeStateEntryValue<PersistedAuthSession>[];
        readonly admission: NewGroupCohortAdmissionInput | null;
        readonly finishedRetentionMs: number;
    }
}

export class MatchmakingService {
    readonly expire: RallarServerAppInbox.Operation<MatchmakingDeadline, MatchmakingDeadline>;
    readonly mutate: RallarServerAppInbox.Operation<MatchmakingCommand, MatchmakingMutationResult>;
    private readonly dependencies: MatchmakingService.Dependencies;
    private readonly config: MatchmakingService.Config;

    constructor(dependencies: MatchmakingService.Dependencies, config: MatchmakingService.Config) {
        this.dependencies = dependencies;
        this.config = config;
        this.expire = this.registerExpiry();
        this.mutate = dependencies.appInbox.register({
            type: 'app:rallar-matchmaking:mutate',
            decodeEnvelope: ({ data }) => decodeMatchmakingCommand(data),
            encodeEnvelope: (command) => ({ data: decodeJsonWireValue(command, 'Matchmaking command') }),
            toBinding: (command) => ({
                contextId: computeSha256CanonicalJson({ scope: command.scope, principalId: command.principalId }),
                resourceId: command.requestId
            }),
            toLogicalCommand: (command) =>
                decodeJsonWireValue(
                    { ...command, capturedAtEpochMs: null, policy: null, serviceId: null },
                    'Logical matchmaking command'
                ),
            materialize: (command) => ({
                ...command,
                capturedAtEpochMs: dependencies.nowEpochMs(),
                serviceId: config.serviceId,
                policy: Object.hasOwn(config.policiesByApplication, command.scope.applicationId)
                    ? config.policiesByApplication[command.scope.applicationId]!
                    : config.defaultPolicy
            }),
            encodeResult: (result) => decodeJsonWireValue(result, 'Matchmaking result'),
            decodeResult: decodeMatchmakingResult,
            handle: (command, context) => this.execute(command, context)
        });
    }

    private registerExpiry(): RallarServerAppInbox.Operation<MatchmakingDeadline, MatchmakingDeadline> {
        return this.dependencies.appInbox.register({
            type: 'app:rallar-matchmaking:expire',
            decodeEnvelope: ({ data }) => decodeMatchmakingDeadline(data),
            encodeEnvelope: (command) => ({ data: decodeJsonWireValue(command, 'Matchmaking deadline') }),
            toBinding: (command) => ({
                contextId: computeSha256CanonicalJson(command.scope),
                resourceId: command.deadlineId
            }),
            toLogicalCommand: (command) => decodeJsonWireValue(command, 'Matchmaking deadline'),
            materialize: (command) => command,
            encodeResult: (result) => decodeJsonWireValue(result, 'Matchmaking expiry result'),
            decodeResult: (value, command) => {
                const result = decodeMatchmakingDeadline(value);
                if (!jsonEquals(result, command)) {
                    throw new TypeError('Matchmaking expiry result differs from its command');
                }
                return result;
            },
            handle: (command, context) => this.executeExpiry(command, context)
        });
    }

    private async executeExpiry(
        command: MatchmakingDeadline,
        context: AppInboxMessageContext<MatchmakingDeadline>
    ): Promise<MatchmakingDeadline> {
        const nowEpochMs = this.dependencies.nowEpochMs();
        if (nowEpochMs < command.dueAtEpochMs) {
            throw new Error('Matchmaking deadline is not due');
        }
        const read = await this.dependencies.repository.read(command.scope);
        const input = {
            pool: read.pool,
            policy: this.config.defaultPolicy,
            nowEpochMs,
            command: { action: 'expire' as const }
        };
        const transition = computeMatchmaking(input);
        const storageInput = { read, transition, finishedRetentionMs: this.config.finishedRetentionMs };
        const computed = computeMatchmakingStorage(storageInput);
        const issue = validateComputedProjection(
            computeMatchmakingStorage({ ...storageInput, transition: computeMatchmaking(input) }),
            computed,
            'Matchmaking expiry'
        )[0];
        if (issue !== undefined) {
            throw issue.cause;
        }
        return await this.dependencies.appInbox.commit(context, command, async (transaction) => {
            if (transition.finished.length > 0) {
                await writeMatchmakingStorage(transaction, computed);
            }
        });
    }

    private async execute(
        command: MatchmakingCommand,
        context: AppInboxMessageContext<MatchmakingMutationResult>
    ): Promise<MatchmakingMutationResult> {
        const event = {
            component: 'matchmaking',
            principalId: command.principalId,
            requestId: command.requestId,
            traceId: context.message.id.traceId,
            details: { attempt: context.entry.dequeueAudit.attempts }
        };
        const timing = this.dependencies.timing;
        const read = await timeRallarAsync(
            timing,
            { ...event, operation: 'read' },
            () => this.read(command, toAppInboxCommandAttempt(context))
        );
        const computed = await timeRallarAsync(
            timing,
            { ...event, operation: 'compute' },
            async () => computeMatchmakingMutation(read)
        );
        const issues = await timeRallarAsync(
            timing,
            { ...event, operation: 'validate' },
            async () => validateMatchmakingMutation(read, computed)
        );
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
        return await timeRallarAsync(timing, { ...event, operation: 'commit' }, () =>
            this.dependencies.appInbox.commit(
                context,
                computed.result,
                (transaction) =>
                    timeRallarAsync(timing, { ...event, operation: 'write' }, () =>
                        writeMatchmakingMutation(transaction, computed))
            ));
    }

    private async read(command: MatchmakingCommand, attempt: AppInboxCommandAttempt): Promise<MatchmakingService.Read> {
        const nowEpochMs = Math.max(this.dependencies.nowEpochMs(), command.capturedAtEpochMs ?? 0);
        const [pool, actor, finished] = await Promise.all([
            this.dependencies.repository.read(command.scope),
            this.dependencies.authSessions.findSessionBySessionIdEntry(command.sessionId),
            this.dependencies.repository.readFinished({
                scope: command.scope,
                principalId: command.principalId,
                searchId: command.request.searchId,
                nowEpochMs
            })
        ]);
        const proposal = pendingAdmission(pool.pool.proposals, command, nowEpochMs);
        const sessions = actor === undefined ? [] : [actor];
        if (proposal !== null) {
            const readSessionIds = new Set([command.sessionId]);
            for (const participant of proposal.participants) {
                if (readSessionIds.has(participant.sessionId)) {
                    continue;
                }
                readSessionIds.add(participant.sessionId);
                const session = await this.dependencies.authSessions.findSessionBySessionIdEntry(participant.sessionId);
                if (session !== undefined) {
                    sessions.push(session);
                }
            }
        }
        const admission = proposal === null ? null : await readMatchmakingAdmission({
            groups: this.dependencies.groups,
            proposal,
            command,
            nowEpochMs,
            ...attempt,
            finishedRetentionMs: this.config.finishedRetentionMs
        });
        return {
            command,
            attempt,
            nowEpochMs,
            pool,
            finished,
            sessions,
            admission,
            finishedRetentionMs: this.config.finishedRetentionMs
        };
    }
}

function pendingAdmission(
    proposals: readonly MatchmakingProposal[],
    command: MatchmakingCommand,
    nowEpochMs: number
): MatchmakingProposal | null {
    if (command.request.action !== 'confirm') {
        return null;
    }
    const proposal = proposals.find((proposal) =>
        proposal.expiresAtEpochMs > nowEpochMs &&
        proposal.participants.some((player) =>
            player.principalId === command.principalId && player.searchId === command.request.searchId
        ) &&
        proposal.participants.every((player) =>
            player.principalId === command.principalId || player.confirmedAtEpochMs !== null
        )
    );
    return proposal === undefined ? null : {
        ...proposal,
        participants: proposal.participants.map((player) =>
            player.principalId !== command.principalId ? player : {
                ...player,
                sessionId: command.sessionId,
                sessionIssuedAtEpochMs: command.sessionIssuedAtEpochMs,
                sessionExpiresAtEpochMs: command.sessionExpiresAtEpochMs
            }
        )
    };
}
