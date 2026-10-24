import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { decodePersistedAppInboxEnqueue } from '@shared-server/rallar-system/app-inbox/app-inbox-command-decoding.ts';
import {
    AppInboxType,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import type { AppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import type {
    AppInboxEntryRepository,
    AppInboxResultRepository
} from '@shared-server/rallar-system/app-inbox/app-inbox-persistence-ports.ts';
import { toPhysicalAppInboxQueueKey } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import {
    encodeAppInboxCommand,
    encodeAppInboxResult
} from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import {
    assertMatchingAppInboxCommand,
    assertMatchingAppInboxEnqueue
} from '@shared-server/rallar-system/app-inbox/assert-matching-app-inbox-command.ts';
import type { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import {
    createAppInboxClientRuntime,
    type AppInboxClientRuntime
} from '@shared-server/rallar-system/app-inbox/client/create-app-inbox-client-runtime.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-completion-computation.ts';
import {
    createAppInboxHandlerRuntime,
    type AppInboxHandlerRuntime
} from '@shared-server/rallar-system/app-inbox/handler/app-inbox-handler-runtime.ts';
import { toLogicalAppInboxCommand } from '@shared-server/rallar-system/app-inbox/logical-app-inbox-command.ts';
import { timeRallarAsync, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import {
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared-server/rallar-system/protocol/exact-object-decoding.ts';
import { serializeCanonicalMutationCommand } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { toRelicRoomGroupRef, type RelicGameState } from '../mod.ts';
import { encodeRelicGameStateAppData } from './encode-relic-game-state-app-data.ts';
import {
    captureRelicGameCommand,
    decodeRelicGameCommand,
    decodeRelicGameIngress,
    type RelicGameMutationService
} from './relic-game-mutation-service.ts';

export namespace RelicGameInboxService {
    export interface Entries extends AppInboxEntryRepository {
        findByKey(key: Key): Promise<ResourceEntry | null>;
    }

    export interface Dependencies {
        readonly service: RelicGameMutationService;
        readonly inboxQueueReader: InboxQueueReader;
        readonly resourceInboxRepository: Entries;
        readonly resourceInboxResultsRepository: AppInboxResultRepository;
        readonly database: PSqlSql;
        readonly wakeQueue: () => void;
    }

    export interface Config {
        readonly serviceId: string;
        readonly serverPeerId: string;
        readonly timing?: RallarTimingSink;
        readonly options?: AppInboxOptions;
    }
}

/** Owns transport admission and durable completion; the mutation service owns one fresh attempt. */
export class RelicGameInboxService {
    private readonly dependencies: RelicGameInboxService.Dependencies;
    private readonly config: RelicGameInboxService.Config;
    private readonly client: AppInboxClientRuntime;
    private readonly handler: AppInboxHandlerRuntime;

    constructor(dependencies: RelicGameInboxService.Dependencies, config: RelicGameInboxService.Config) {
        this.dependencies = dependencies;
        this.config = config;
        this.client = createAppInboxClientRuntime({
            ...dependencies,
            ...config,
            defaultTopicId: AppInboxType.RELIC_GAME_MUTATE,
            wakeOwningQueue: dependencies.wakeQueue
        });
        this.handler = createAppInboxHandlerRuntime({
            ...dependencies,
            ...config,
            resultRepository: dependencies.resourceInboxResultsRepository
        });
        this.handler.registry.registerHandler({
            type: AppInboxType.RELIC_GAME_MUTATE,
            decodeCommand: decodeRelicGameCommand,
            encodeResult: (result: RelicGameMutationService.Result) =>
                encodeAppInboxResult(result, 'Relic mutation result'),
            handle: (command, context) => this.process(command, context)
        });
    }

    async enqueue(
        value: RelicGameMutationService.CommandInput,
        createInitialState: () => Promise<RelicGameState>
    ): Promise<AppInboxResultWaiter.Wait> {
        const command = captureRelicGameCommand(value);
        const received = toRelicEnqueue(command, null);
        const key = toPhysicalAppInboxQueueKey({ ...received, resourceId: command.requestId });
        const identity = serializeCanonicalMutationCommand(toLogicalAppInboxCommand(received));
        const retained = await this.dependencies.resourceInboxRepository.findByKey(key);
        if (retained !== null) {
            assertMatchingAppInboxCommand(retained, received, identity);
            return { key, enqueue: decodePersistedAppInboxEnqueue(retained), winner: false };
        }
        // Proposal generation may use AI. It completes before the reservation transaction is entered.
        const service = this.dependencies.service;
        const observed = await service.read(service.capture(command, null, this.config.serverPeerId));
        const initial = service.needsInitialState(observed) ? await createInitialState() : null;
        const ingress = service.capture(command, initial, this.config.serverPeerId);
        const prepared = toRelicEnqueue(command, ingress);
        const reservation = await this.client.reservationClient.reserveMaterializedEntry(
            received,
            async () => prepared
        );
        assertMatchingAppInboxEnqueue({
            resourceId: key.resourceId,
            existing: reservation.enqueue,
            incoming: received,
            receivedCommandIdentity: identity
        });
        this.dependencies.wakeQueue();
        return reservation;
    }

    async wait(reservation: AppInboxResultWaiter.Wait): Promise<RelicGameMutationService.Result> {
        const command = decodeRelicGameCommand(reservation.enqueue.data);
        const outcome = await this.client.resultWaiter.waitForResult(
            reservation,
            (value) => decodeRelicGameResult(value, command)
        );
        return outcome.fold((failure) => {
            throw new RelicGameInboxFailureError(failure);
        }, (result) => result);
    }

    async execute(
        command: RelicGameMutationService.CommandInput,
        createInitialState: () => Promise<RelicGameState>
    ): Promise<RelicGameMutationService.Result> {
        return await this.wait(await this.enqueue(command, createInitialState));
    }

    private async process(
        command: RelicGameMutationService.Command,
        context: AppInboxMessageContext<RelicGameMutationService.Result>
    ): Promise<RelicGameMutationService.Result> {
        const ingress = decodeRelicGameIngress(context.enqueue.authority);
        if (!jsonEquals(command, ingress.command) || !jsonEquals(context.enqueue, toRelicEnqueue(command, ingress))) {
            throw new TypeError('Relic queue identity differs from its canonical ingress');
        }
        const service = this.dependencies.service;
        const timing = {
            component: 'relic-game',
            serviceId: this.config.serviceId,
            requestId: command.requestId,
            ...toRelicRoomGroupRef(command.gameId),
            principalId: command.actor.clientId,
            sessionId: command.actor.sessionId,
            details: { attempt: context.entry.dequeueAudit.attempts }
        };
        const read = await timeRallarAsync(
            this.config.timing,
            { ...timing, operation: 'read' },
            () => service.read(ingress)
        );
        const computed = await timeRallarAsync(
            this.config.timing,
            { ...timing, operation: 'compute' },
            async () => service.compute(read)
        );
        await timeRallarAsync(this.config.timing, { ...timing, operation: 'validate' }, async () => {
            const issue = service.validate(read, computed)[0];
            if (issue !== undefined) {
                throw issue.cause;
            }
        });
        const completionFacts = {
            ...this.handler.transactionWriter.readCompletionFacts(context),
            durableResult: computed.result,
            status: EntityStatus.COMPLETED
        };
        const completion = computeAppInboxCompletion(completionFacts);
        const completionIssue = validateAppInboxCompletion(completionFacts, completion)[0];
        if (completionIssue !== undefined) {
            throw completionIssue.cause;
        }
        const result = await timeRallarAsync(
            this.config.timing,
            { ...timing, operation: 'write' },
            () =>
                this.handler.transactionWriter.writeComputedMutation(
                    context,
                    completion,
                    (transaction) => service.write(transaction, computed)
                )
        );
        this.dependencies.wakeQueue();
        return result;
    }
}

export class RelicGameInboxFailureError extends Error {
    readonly failure: AppInboxFailure;

    constructor(failure: AppInboxFailure) {
        super(failure.message);
        this.name = 'RelicGameInboxFailureError';
        this.failure = failure;
    }
}

function toRelicEnqueue(
    command: RelicGameMutationService.Command,
    ingress: RelicGameMutationService.Ingress | null
): AppInboxEnqueueInput {
    return {
        type: AppInboxType.RELIC_GAME_MUTATE,
        topicId: AppInboxType.RELIC_GAME_MUTATE,
        contextId: command.gameId,
        resourceId: command.requestId,
        senderId: command.actor.sessionId,
        authority: ingress === null ? null : encodeAppInboxCommand({
            ...ingress,
            initial: ingress.initial === null ? null : encodeRelicGameStateAppData(ingress.initial)
        }, 'Relic mutation ingress'),
        data: encodeAppInboxCommand(command, 'Relic mutation command')
    };
}

function decodeRelicGameResult(
    value: unknown,
    command: RelicGameMutationService.Command
): RelicGameMutationService.Result {
    const result = requireRecord(value, 'Relic mutation result');
    const status = requireOneOf(result.status, ['initialized', 'applied', 'refused'], 'Relic result status');
    requireString(result.gameId, 'Relic result game ID');
    if (result.gameId !== command.gameId) {
        throw new TypeError('Relic result differs from its requested game');
    }
    if (status !== 'refused') {
        const expected = command.operation === 'ensure' ? 'initialized' : 'applied';
        if (status !== expected) {
            throw new TypeError('Relic result differs from its requested operation');
        }
        requireExactKeys(result, ['status', 'gameId'], 'Relic mutation result');
        return { status, gameId: result.gameId };
    }
    requireExactKeys(result, ['status', 'gameId', 'code', 'message', 'httpStatus'], 'Relic mutation refusal');
    requireString(result.code, 'Relic refusal code');
    requireString(result.message, 'Relic refusal message');
    const httpStatus = result.httpStatus;
    if (httpStatus !== 401 && httpStatus !== 403 && httpStatus !== 404 && httpStatus !== 409) {
        throw new TypeError('Relic refusal HTTP status is invalid');
    }
    return { status, gameId: result.gameId, code: result.code, message: result.message, httpStatus };
}
