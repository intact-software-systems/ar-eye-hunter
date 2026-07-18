import { Temporal } from '@js-temporal/polyfill';
import { ALMessage, newALRoute, newALUntargetedMessage, } from '@shared/al-contracts/al-contract.ts';
import {
    EntityStatus,
    Key,
    ResourceEntry,
    toResourceEntryWithUpdatedResource,
} from '@shared/queuebox/ResourceEntry.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { Either } from '@shared/resilience/Either.ts';
import { TryWithExhaustedError, TryWithPolicy, tryWithPolicy } from '@shared/resilience/TryWith.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import { ResourceInboxRepository } from '@shared-server/postgres/resource-inbox/ResourceInboxRepository.ts';
import {
    ResourceInboxResultsRepository
} from '@shared-server/postgres/resource-inbox/ResourceInboxResultsRepository.ts';
import { type RallarTimingDetails, type RallarTimingSink, recordRallarTiming, timeRallarAsync, } from './timing.ts';
import { isGroupPolicyDeniedError } from '../group-policy.ts';
import { hashStateMutationCommand } from '../repositories/StateMutationOutboxRepository.ts';
import {
    toAppInboxQueueCreatedBy,
    toAppInboxQueueKey,
} from './app-inbox-queue-key.ts';

export const SIMPLER_GROUP_STATE_APP_INBOX_TOPIC = 'app-inbox.group-state';
export const SIMPLER_CLIENT_STATE_APP_INBOX_TOPIC = 'app-inbox.client-state';

export enum AppInboxType {
    CLIENT_PRINCIPAL_UPSERT = 'CLIENT_PRINCIPAL_UPSERT',
    CLIENT_INSTANCE_UPSERT = 'CLIENT_INSTANCE_UPSERT',
    CLIENT_SESSION_CONNECT = 'CLIENT_SESSION_CONNECT',
    CLIENT_SESSION_HEARTBEAT = 'CLIENT_SESSION_HEARTBEAT',
    CLIENT_SESSION_DISCONNECT = 'CLIENT_SESSION_DISCONNECT',
    CLIENT_AUTHORISED_WS_CONNECT = 'CLIENT_AUTHORISED_WS_CONNECT',
    CLIENT_AUTHORISED_WS_DISCONNECT = 'CLIENT_AUTHORISED_WS_DISCONNECT',
    CLIENT_EXPIRED_SESSIONS = 'CLIENT_EXPIRED_SESSIONS',
    GROUP_CREATE = 'GROUP_CREATE',
    GROUP_UPDATE = 'GROUP_UPDATE',
    GROUP_DIRECTOR_APPOINT = 'GROUP_DIRECTOR_APPOINT',
    GROUP_JOIN = 'GROUP_JOIN',
    GROUP_INVITE_CREATE = 'GROUP_INVITE_CREATE',
    GROUP_INVITE_REVOKE = 'GROUP_INVITE_REVOKE',
    GROUP_INVITE_ACCEPT = 'GROUP_INVITE_ACCEPT',
    GROUP_JOIN_CODE_ROTATE = 'GROUP_JOIN_CODE_ROTATE',
    GROUP_MEMBER_REMOVE = 'GROUP_MEMBER_REMOVE',
    GROUP_MEMBER_BAN = 'GROUP_MEMBER_BAN',
    GROUP_MEMBER_UNBAN = 'GROUP_MEMBER_UNBAN',
    GROUP_MEMBER_ROLE_SET = 'GROUP_MEMBER_ROLE_SET',
    GROUP_OWNERSHIP_TRANSFER = 'GROUP_OWNERSHIP_TRANSFER',
    GROUP_MEMBER_UPSERT = 'GROUP_MEMBER_UPSERT',
    GROUP_PRESENCE_CONNECT = 'GROUP_PRESENCE_CONNECT',
    GROUP_PRESENCE_HEARTBEAT = 'GROUP_PRESENCE_HEARTBEAT',
    GROUP_PRESENCE_DISCONNECT = 'GROUP_PRESENCE_DISCONNECT',
    GROUP_PRESENCE_DISCONNECT_BY_SESSION_ID = 'GROUP_PRESENCE_DISCONNECT_BY_SESSION_ID',
    GROUP_EXPIRED_PRESENCE_SESSIONS = 'GROUP_EXPIRED_PRESENCE_SESSIONS',
}

export { NonRetryableException };

export class AppInboxIdempotencyConflictError extends Error {
    readonly code = 'app-inbox-idempotency-conflict';
    readonly status = 409;

    constructor(
        readonly resourceId: string,
        readonly existingCommandHash: string,
        readonly receivedCommandHash: string,
    ) {
        super(`App inbox idempotency conflict for resource ${resourceId}`);
        this.name = 'AppInboxIdempotencyConflictError';
    }
}

export type AppInboxEnqueueInput<V> = {
    type: AppInboxType;
    topicId?: string;
    resourceId?: string;
    contextId?: string;
    senderId?: string;
    data: V;
};

export type AppInboxServiceOptions = Readonly<{
    phaseTiming?: boolean;
    waitMaxElapsedMsecs?: number;
    waitRetryIntervalMsecs?: number;
    waitMaxRetryIntervalMsecs?: number;
    waitJitterRatio?: number;
}>;

type NormalizedAppInboxServiceOptions = Required<AppInboxServiceOptions>;

export class AppInboxService {
    public static readonly MAX_ELAPSED_MSECS = 10_000;
    public static readonly WAIT_RETRY_INTERVAL_MSECS = 500;
    public static readonly WAIT_MAX_RETRY_INTERVAL_MSECS = 20_000;
    public static readonly WAIT_JITTER_RATIO = 0.2;

    private readonly options: NormalizedAppInboxServiceOptions;

    constructor(
        public readonly inbox: InboxQueueReader,
        public readonly resourceInbox: ResourceInboxRepository,
        public readonly resourceInboxResults: ResourceInboxResultsRepository,
        public readonly serviceId: string,
        private readonly defaultTopicId: string = SIMPLER_GROUP_STATE_APP_INBOX_TOPIC,
        private readonly timing?: RallarTimingSink,
        options: AppInboxServiceOptions = {},
    ) {
        this.options = {
            phaseTiming: options.phaseTiming ?? false,
            waitMaxElapsedMsecs: toNonNegativeFiniteNumber(
                options.waitMaxElapsedMsecs,
                AppInboxService.MAX_ELAPSED_MSECS,
            ),
            waitRetryIntervalMsecs: toNonNegativeFiniteNumber(
                options.waitRetryIntervalMsecs,
                AppInboxService.WAIT_RETRY_INTERVAL_MSECS,
            ),
            waitMaxRetryIntervalMsecs: toNonNegativeFiniteNumber(
                options.waitMaxRetryIntervalMsecs,
                AppInboxService.WAIT_MAX_RETRY_INTERVAL_MSECS,
            ),
            waitJitterRatio: toRatio(
                options.waitJitterRatio,
                AppInboxService.WAIT_JITTER_RATIO,
            ),
        };
    }

    public processEntryNoWaiting<V, R = V>(enqueue: AppInboxEnqueueInput<V>) {
        this.processEntryUntilCompletionInternal(
                enqueue,
                false,
                true,
                async (key, wireEnqueue) => {
                    return await this.inbox.enqueueIfAbsent(
                        newALUntargetedMessage(
                            toAppInboxQueueCreatedBy(this.serviceId),
                            newALRoute(key.topicId, key.contextId, key.resourceId),
                            wireEnqueue.type.toString(),
                            wireEnqueue,
                        ),
                    );
                }
            )
            .catch((err) => {
                console.error(`Error processing entry without waiting: ${err}`);
            });
    }

    // use this from client/group cleanup of expired
    public processEntryNoWaitingIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean
    ) {
        this.processEntryUntilCompletionInternal(
                enqueue,
                false,
                false,
                async (key, wireEnqueue) => {
                    return await this.inbox.enqueueIf(
                        newALUntargetedMessage(
                            toAppInboxQueueCreatedBy(this.serviceId),
                            newALRoute(key.topicId, key.contextId, key.resourceId),
                            wireEnqueue.type.toString(),
                            wireEnqueue,
                        ),
                        enqueueIf
                    );
                }
            )
            .catch((err) => {
                console.error(`Error processing entry without waiting: ${err}`);
            });
    }

    public async processEntryUntilCompletion<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
    ): Promise<Either<string, R>> {
        return await this.processEntryUntilCompletionInternal(
            enqueue,
            true,
            true,
            async (key, wireEnqueue) => {
                return await this.inbox.enqueueIfAbsent(
                    newALUntargetedMessage(
                        toAppInboxQueueCreatedBy(this.serviceId),
                        newALRoute(key.topicId, key.contextId, key.resourceId),
                        wireEnqueue.type.toString(),
                        wireEnqueue,
                    ),
                );
            }
        );
    }

    public async processEntryUntilCompletionIf<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        enqueueIf: (entry: ResourceEntry) => boolean
    ): Promise<Either<string, R>> {
        return await this.processEntryUntilCompletionInternal(
            enqueue,
            true,
            false,
            async (key, wireEnqueue) => {
                return await this.inbox.enqueueIf(
                    newALUntargetedMessage(
                        toAppInboxQueueCreatedBy(this.serviceId),
                        newALRoute(key.topicId, key.contextId, key.resourceId),
                        wireEnqueue.type.toString(),
                        wireEnqueue,
                    ),
                    enqueueIf
                );
            }
        );
    }

    private async processEntryUntilCompletionInternal<V, R = V>(
        enqueue: AppInboxEnqueueInput<V>,
        waitForCompletion: boolean,
        enforceCommandIdentity: boolean,
        enqueuer: (
            key: Key,
            wireEnqueue: AppInboxEnqueueInput<V>,
        ) => Promise<ResourceEntry | undefined>
    ): Promise<Either<string, R>> {
        const wireEnqueue = toJsonWireAppInboxEnqueue(enqueue);
        const key: Key = this.toKey(wireEnqueue);

        return await timeRallarAsync(
            this.timing,
            {
                component: 'app-inbox',
                operation: 'processEntryUntilCompletion',
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: {
                    type: enqueue.type,
                    waitForCompletion,
                    topicId: key.topicId,
                    contextId: key.contextId,
                    resourceId: key.resourceId,
                    senderId: enqueue.senderId,
                },
            },
            async () => {
                const entry = await this.timePhase(
                    'enqueue',
                    enqueue,
                    key,
                    async () => await enqueuer(key, wireEnqueue),
                );
                if (entry && enforceCommandIdentity) {
                    await assertMatchingAppInboxCommand(wireEnqueue, entry);
                }

                if (!waitForCompletion) {
                    return Either.ofLeft('No waiting for completion');
                }

                const isCompleted = await this.waitForCompletion(wireEnqueue, key);

                if (!isCompleted) {
                    return Either.ofLeft('App inbox entry not completed');
                }

                return await this.timePhase(
                    'read-result',
                    enqueue,
                    key,
                    async () => await this.findByKeyAndReturnEither<R>(key),
                );
            },
        );
    }

    private async findByKeyAndReturnEither<R>(
        key: Key,
    ): Promise<Either<string, R>> {
        const result = await this.resourceInboxResults.findByKey(key);
        if (result === undefined) {
            return Either.ofLeft('App inbox entry not found');
        }
        if (result.status === EntityStatus.FAILED) {
            return Either.ofLeft(toAppInboxErrorMessage(result.resource));
        }
        if (result.status !== EntityStatus.COMPLETED) {
            return Either.ofLeft('App inbox entry not completed');
        }

        return Either.ofRight(JSON.parse(result.resource) as R);
    }

    private async waitForCompletion<V>(
        enqueue: AppInboxEnqueueInput<V>,
        key: Key,
    ): Promise<boolean> {
        try {
            return await this.timePhase(
                'wait-completion',
                enqueue,
                key,
                async () => await tryWithPolicy<boolean>(
                    async () => {
                        const isCompleted =
                            await this.resourceInbox.isEntryWithStatus(
                                key,
                                [
                                    EntityStatus.COMPLETED,
                                    EntityStatus.FAILED,
                                ]
                            );

                        if (!isCompleted) {
                            throw new Error('App inbox entry not found');
                        }

                        return true;
                    },
                    this.toWaitPolicy(enqueue, key),
                ),
                {
                    waitMaxElapsedMsecs: this.options.waitMaxElapsedMsecs,
                },
            );
        } catch (error) {
            if (!(error instanceof TryWithExhaustedError)) {
                throw error;
            }

            recordRallarTiming(
                this.timing,
                {
                    component: 'app-inbox-phase',
                    operation: 'wait-fallback',
                    serviceId: this.serviceId,
                    requestId: enqueue.resourceId,
                    details: {
                        ...this.toTimingDetails(enqueue, key),
                        attempt: error.context.attempt,
                        elapsedMsecs: error.context.elapsedMsecs,
                        waitMaxElapsedMsecs: this.options.waitMaxElapsedMsecs,
                        errorName: error.name,
                        errorMessage: error.message,
                    },
                },
                'ok',
                0,
            );
            return false;
        }
    }

    onStateMessage<V>(
        type: AppInboxType,
        handler: (data: V) => Promise<unknown>,
    ): void {
        this.inbox.onInboxMessageDo(
            type,
            {
                onMessage: async (message: ALMessage, entry: ResourceEntry) => {
                    const enqueue = JSON.parse(
                        message.payload.resource,
                    ) as AppInboxEnqueueInput<V>;

                    await timeRallarAsync(
                        this.timing,
                        {
                            component: 'app-inbox-handler',
                            operation: String(type),
                            serviceId: this.serviceId,
                            requestId: enqueue.resourceId,
                            details: {
                                type: enqueue.type,
                                topicId: entry.key.topicId,
                                contextId: entry.key.contextId,
                                resourceId: entry.key.resourceId,
                                senderId: enqueue.senderId,
                            },
                        },
                        async () => {
                            try {
                                const result = await this.timePhase(
                                    'handler-action',
                                    enqueue,
                                    entry.key,
                                    async () => await handler(enqueue.data),
                                );
                                await this.timePhase(
                                    'write-result',
                                    enqueue,
                                    entry.key,
                                    async () => {
                                        await this.writeAppInboxResult(
                                            entry,
                                            EntityStatus.COMPLETED,
                                            result,
                                        );
                                    },
                                    { resultStatus: EntityStatus.COMPLETED },
                                );
                            } catch (error) {
                                const terminalError = toTerminalAppInboxError(error);
                                if (terminalError === undefined) {
                                    this.recordQueueRetryTiming(enqueue, entry, error);
                                    throw error;
                                }

                                await this.timePhase(
                                    'write-result',
                                    enqueue,
                                    entry.key,
                                    async () => {
                                        await this.writeAppInboxResult(
                                            entry,
                                            EntityStatus.FAILED,
                                            terminalError,
                                        );
                                    },
                                    { resultStatus: EntityStatus.FAILED },
                                );
                            }
                        },
                    );
                },
            });
    }

    private recordQueueRetryTiming<V>(
        enqueue: AppInboxEnqueueInput<V>,
        entry: ResourceEntry,
        error: unknown,
    ): void {
        recordRallarTiming(
            this.timing,
            {
                component: 'app-inbox-handler',
                operation: 'queue-retry',
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: {
                    ...this.toTimingDetails(enqueue, entry.key),
                    attempts: entry.dequeueAudit.attempts,
                    queueAgeMs: toQueueAgeMs(entry),
                    errorName: error instanceof Error ? error.name : undefined,
                    errorMessage: error instanceof Error ? error.message : String(error),
                },
            },
            'ok',
            0,
            error,
        );
    }

    private async writeAppInboxResult(
        entry: ResourceEntry,
        status: EntityStatus.COMPLETED | EntityStatus.FAILED,
        value: unknown,
    ): Promise<void> {
        await this.resourceInboxResults.replace(
            toResourceEntryWithUpdatedResource(entry, status, value),
        );
    }

    private toWaitPolicy<V>(
        enqueue: AppInboxEnqueueInput<V>,
        key: Key,
    ): TryWithPolicy {
        let policy = TryWithPolicy.defaults()
            .label(`app-inbox:${key.topicId}:${key.resourceId}`)
            .maxElapsedMsecs(this.options.waitMaxElapsedMsecs)
            .retryIntervalMsecs(this.options.waitRetryIntervalMsecs)
            .maxRetryIntervalMsecs(this.options.waitMaxRetryIntervalMsecs)
            .jitterRatio(this.options.waitJitterRatio);

        if (this.options.phaseTiming) {
            policy = policy.onRetry((context) => {
                recordRallarTiming(
                    this.timing,
                    {
                        component: 'app-inbox-phase',
                        operation: 'wait-retry',
                        serviceId: this.serviceId,
                        requestId: enqueue.resourceId,
                        details: {
                            ...this.toTimingDetails(enqueue, key),
                            attempt: context.attempt,
                            nextAttempt: context.nextAttempt,
                            delayMsecs: context.delayMsecs,
                            elapsedMsecs: context.elapsedMsecs,
                            errorName: context.error instanceof Error
                                ? context.error.name
                                : undefined,
                            errorMessage: context.error instanceof Error
                                ? context.error.message
                                : String(context.error),
                        },
                    },
                    'ok',
                    0,
                );
            });
        }

        return policy;
    }

    private async timePhase<T, V>(
        operation: string,
        enqueue: AppInboxEnqueueInput<V>,
        key: Key,
        action: () => Promise<T>,
        details: RallarTimingDetails = {},
    ): Promise<T> {
        if (!this.options.phaseTiming) {
            return await action();
        }

        return await timeRallarAsync(
            this.timing,
            {
                component: 'app-inbox-phase',
                operation,
                serviceId: this.serviceId,
                requestId: enqueue.resourceId,
                details: {
                    ...this.toTimingDetails(enqueue, key),
                    ...details,
                },
            },
            action,
        );
    }

    private toTimingDetails<V>(
        enqueue: AppInboxEnqueueInput<V>,
        key: Key,
    ): RallarTimingDetails {
        return {
            type: enqueue.type,
            topicId: key.topicId,
            contextId: key.contextId,
            resourceId: key.resourceId,
            senderId: enqueue.senderId,
        };
    }

    private toKey<V>(enqueue: AppInboxEnqueueInput<V>) {
        return toAppInboxQueueKey({
            topicId: enqueue.topicId ?? this.defaultTopicId,
            resourceId: enqueue.resourceId ?? crypto.randomUUID().toString(),
            contextId: enqueue.contextId ?? enqueue.senderId ?? 'rallar-server',
        });
    }
}

function toAppInboxErrorMessage(resource: string): string {
    try {
        const parsed = JSON.parse(resource) as unknown;
        if (typeof parsed === 'string') {
            return parsed;
        }
        if (isSerializedPolicyDenial(parsed)) {
            return JSON.stringify(parsed);
        }
        if (
            parsed &&
            typeof parsed === 'object' &&
            'error' in parsed &&
            typeof parsed.error === 'string'
        ) {
            return parsed.error;
        }
        return JSON.stringify(parsed);
    } catch {
        return resource;
    }
}

function toTerminalAppInboxError(error: unknown): unknown | undefined {
    if (isGroupPolicyDeniedError(error)) {
        return {
            error: error.message,
            code: error.denial.code,
            message: error.denial.message,
            details: error.denial.details,
        };
    }

    if (error instanceof NonRetryableException) {
        return error instanceof Error ? error.message : String(error);
    }

    if (isTerminalDomainError(error)) {
        return {
            error: error.message,
            code: error.code,
            message: error.message,
            status: error.status,
        };
    }

    return undefined;
}

async function assertMatchingAppInboxCommand<V>(
    incoming: AppInboxEnqueueInput<V>,
    entry: ResourceEntry,
): Promise<void> {
    const receivedCommandHash = await hashStateMutationCommand(
        toLogicalAppInboxCommand(incoming),
    );
    let existing: AppInboxEnqueueInput<unknown>;
    try {
        const message = JSON.parse(entry.resource) as ALMessage;
        existing = JSON.parse(message.payload.resource) as AppInboxEnqueueInput<unknown>;
    } catch {
        throw new AppInboxIdempotencyConflictError(
            entry.key.resourceId,
            'invalid-existing-command',
            receivedCommandHash,
        );
    }
    const existingCommandHash = await hashStateMutationCommand(
        toLogicalAppInboxCommand(existing),
    );
    if (existingCommandHash !== receivedCommandHash) {
        throw new AppInboxIdempotencyConflictError(
            entry.key.resourceId,
            existingCommandHash,
            receivedCommandHash,
        );
    }
}

function toJsonWireAppInboxEnqueue<V>(
    enqueue: AppInboxEnqueueInput<V>,
): AppInboxEnqueueInput<V> {
    return toJsonWireValue(enqueue, '$', new Set()) as AppInboxEnqueueInput<V>;
}

function toJsonWireValue(
    value: unknown,
    path: string,
    ancestors: Set<object>,
): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) rejectJsonWire(path, 'contains a non-finite number');
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') {
        rejectJsonWire(path, `contains unsupported ${typeof value}`);
    }
    if (ancestors.has(value)) rejectJsonWire(path, 'contains a cycle');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const descriptors = Object.getOwnPropertyDescriptors(value);
            const result: unknown[] = [];
            for (let index = 0; index < value.length; index++) {
                const descriptor = descriptors[String(index)];
                if (!descriptor || !('value' in descriptor)) {
                    rejectJsonWire(`${path}[${index}]`, 'must be a dense data element');
                }
                if (descriptor.value === undefined ||
                    typeof descriptor.value === 'function' ||
                    typeof descriptor.value === 'symbol' ||
                    typeof descriptor.value === 'bigint') {
                    rejectJsonWire(`${path}[${index}]`, 'contains an unsupported array value');
                }
                result.push(toJsonWireValue(
                    descriptor.value,
                    `${path}[${index}]`,
                    ancestors,
                ));
            }
            for (const key of Reflect.ownKeys(descriptors)) {
                if (typeof key === 'symbol') rejectJsonWire(path, 'contains a symbol key');
                if (key === 'length' || /^(0|[1-9]\d*)$/u.test(key)) continue;
                if (descriptors[key]?.enumerable) {
                    rejectJsonWire(path, `contains unsupported array property ${key}`);
                }
            }
            return result;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            rejectJsonWire(path, 'must contain only plain JSON objects');
        }
        const result: Record<string, unknown> = {};
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const key of Reflect.ownKeys(descriptors)) {
            if (typeof key === 'symbol') rejectJsonWire(path, 'contains a symbol key');
            const descriptor = descriptors[key];
            if (!descriptor.enumerable) continue;
            if (!('value' in descriptor)) {
                rejectJsonWire(`${path}.${key}`, 'contains an accessor');
            }
            if (descriptor.value === undefined) continue;
            result[key] = toJsonWireValue(
                descriptor.value,
                `${path}.${key}`,
                ancestors,
            );
        }
        return result;
    } finally {
        ancestors.delete(value);
    }
}

function rejectJsonWire(path: string, detail: string): never {
    throw new TypeError(`App inbox JSON wire ${path} ${detail}`);
}

function toLogicalAppInboxCommand(enqueue: AppInboxEnqueueInput<unknown>): Readonly<{
    type: AppInboxType;
    data: unknown;
}> {
    return {
        type: enqueue.type,
        data: enqueue.data,
    };
}

function isTerminalDomainError(error: unknown): error is Readonly<{
    code: string;
    message: string;
    status: number;
}> {
    return Boolean(
        error instanceof Error &&
        'code' in error &&
        typeof error.code === 'string' &&
        'status' in error &&
        typeof error.status === 'number' &&
        Number.isSafeInteger(error.status) &&
        error.status >= 400 &&
        error.status < 500,
    );
}

function isSerializedPolicyDenial(value: unknown): value is Readonly<{
    error: string;
    code: string;
    message: string;
}> {
    return Boolean(
        value &&
        typeof value === 'object' &&
        'error' in value &&
        typeof value.error === 'string' &&
        'code' in value &&
        typeof value.code === 'string' &&
        'message' in value &&
        typeof value.message === 'string',
    );
}

function toNonNegativeFiniteNumber(
    value: number | undefined,
    fallback: number,
): number {
    return value === undefined || !Number.isFinite(value) || value < 0
        ? fallback
        : value;
}

function toRatio(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.max(0, Math.min(1, value));
}

function toQueueAgeMs(entry: ResourceEntry): number | undefined {
    try {
        return Math.max(
            0,
            Temporal.Now.instant().epochMilliseconds -
                entry.audit.createdTs.toZonedDateTime('UTC').epochMilliseconds,
        );
    } catch {
        return undefined;
    }
}
