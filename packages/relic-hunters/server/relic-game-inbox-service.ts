import type {
    AppInboxFailure,
    AppInboxMessageContext,
    RallarServerAppInbox
} from '@shared-server/mod.ts';
import { toAppInboxCommandAttempt } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { timeRallarAsync, type RallarTimingSink } from '@shared-server/rallar-system/observability/timing.ts';
import {
    requireExactKeys,
    requireOneOf,
    requireRecord,
    requireString
} from '@shared-server/rallar-system/protocol/exact-object-decoding.ts';
import { encodeJsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import { toRelicRoomGroupRef, type RelicGameState } from '../mod.ts';
import { encodeRelicGameStateAppData } from './encode-relic-game-state-app-data.ts';
import {
    captureRelicGameCommand,
    decodeRelicGameCommand,
    decodeRelicGameIngress,
    type RelicGameMutationService
} from './relic-game-mutation-service.ts';

export namespace RelicGameInboxService {
    export interface Dependencies {
        readonly service: RelicGameMutationService;
        readonly appInbox: RallarServerAppInbox;
        readonly wakeQueue: () => void;
    }

    export interface Config {
        readonly serviceId: string;
        readonly serverPeerId: string;
        readonly nowEpochMs: () => number;
        readonly timing?: RallarTimingSink;
    }
}

/** Owns game admission/proposals and one mutation attempt through the application's public AppInbox. */
export class RelicGameInboxService {
    static readonly operation = 'app:relic-hunters:mutate';

    private readonly dependencies: RelicGameInboxService.Dependencies;
    private readonly config: RelicGameInboxService.Config;
    private readonly operation: RallarServerAppInbox.Operation<
        RelicGameMutationService.Ingress,
        RelicGameMutationService.Result
    >;

    constructor(dependencies: RelicGameInboxService.Dependencies, config: RelicGameInboxService.Config) {
        this.dependencies = dependencies;
        this.config = config;
        this.operation = dependencies.appInbox.register({
            type: RelicGameInboxService.operation,
            decodeEnvelope: decodeRelicEnvelope,
            encodeEnvelope: encodeRelicEnvelope,
            toBinding: ({ command }) => ({ contextId: command.gameId, resourceId: command.requestId }),
            toLogicalCommand: ({ command }) => encodeJsonWireValue(command, 'Logical Relic mutation command'),
            materialize: (ingress) => ({ ...ingress, capturedAtEpochMs: config.nowEpochMs() }),
            encodeResult: (result: RelicGameMutationService.Result) =>
                encodeJsonWireValue(result, 'Relic mutation result'),
            decodeResult: (value, ingress) => decodeRelicGameResult(value, ingress.command),
            handle: (ingress, context) => this.mutateGame(ingress, context)
        });
    }

    async enqueue(
        value: RelicGameMutationService.CommandInput,
        createInitialState: () => Promise<RelicGameState>
    ): Promise<RallarServerAppInbox.Admission<RelicGameMutationService.Result>> {
        const command = captureRelicGameCommand(value);
        const ingress: RelicGameMutationService.Ingress = {
            command,
            initial: null,
            // Only reservation materialization captures time; this deterministic admission probe is never retained.
            capturedAtEpochMs: 0,
            serverPeerId: this.config.serverPeerId
        };
        const retained = await this.operation.readAdmission(ingress);
        if (retained) {
            return retained.fold(throwRelicInboxFailure, (admission) => admission);
        }
        const service = this.dependencies.service;
        const observed = await service.read(ingress);
        const initial = service.needsInitialState(observed) ? await createInitialState() : null;
        const admitted = await this.operation.enqueue({ command: { ...ingress, initial }, traceId: value.traceId });
        return admitted.fold(throwRelicInboxFailure, (admission) => admission);
    }

    async wait(
        admission: RallarServerAppInbox.Admission<RelicGameMutationService.Result>
    ): Promise<RelicGameMutationService.Result> {
        const outcome = await admission.wait();
        return outcome.fold(throwRelicInboxFailure, (result) => result);
    }

    async execute(
        command: RelicGameMutationService.CommandInput,
        createInitialState: () => Promise<RelicGameState>
    ): Promise<RelicGameMutationService.Result> {
        return await this.wait(await this.enqueue(command, createInitialState));
    }

    private async mutateGame(
        ingress: RelicGameMutationService.Ingress,
        context: AppInboxMessageContext<RelicGameMutationService.Result>
    ): Promise<RelicGameMutationService.Result> {
        const { command } = ingress;
        const service = this.dependencies.service;
        const timing = {
            component: 'relic-game',
            serviceId: this.config.serviceId,
            requestId: command.requestId,
            traceId: context.message.id.traceId,
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
        const attempt: RelicGameMutationService.Attempt = { ...read, ...toAppInboxCommandAttempt(context) };
        const computed = await timeRallarAsync(
            this.config.timing,
            { ...timing, operation: 'compute' },
            async () => service.compute(attempt)
        );
        await timeRallarAsync(this.config.timing, { ...timing, operation: 'validate' }, async () => {
            const issue = service.validate(attempt, computed)[0];
            if (issue !== undefined) {
                throw issue.cause;
            }
        });
        const result = await timeRallarAsync(
            this.config.timing,
            { ...timing, operation: 'write' },
            () =>
                this.dependencies.appInbox.commit(
                    context,
                    computed.result,
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

function decodeRelicEnvelope(envelope: RallarServerAppInbox.Envelope): RelicGameMutationService.Ingress {
    const command = decodeRelicGameCommand(envelope.data);
    const ingress = decodeRelicGameIngress(envelope.authority);
    if (!jsonEquals(command, ingress.command) || envelope.senderId !== command.actor.sessionId) {
        throw new TypeError('Relic envelope differs from its canonical ingress');
    }
    return ingress;
}

function encodeRelicEnvelope(ingress: RelicGameMutationService.Ingress): RallarServerAppInbox.Envelope {
    return {
        data: encodeJsonWireValue(ingress.command, 'Relic mutation command'),
        senderId: ingress.command.actor.sessionId,
        authority: encodeJsonWireValue({
            ...ingress,
            initial: ingress.initial === null ? null : encodeRelicGameStateAppData(ingress.initial)
        }, 'Relic mutation ingress')
    };
}

function throwRelicInboxFailure(failure: AppInboxFailure): never {
    throw new RelicGameInboxFailureError(failure);
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
