import { Temporal } from '@js-temporal/polyfill';

import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import type { AuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, isExpiredResourceEntry, toKeyAsString, type Key, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import type { AppInboxTestDatabase, AppInboxTestDatabaseOptions } from '../app-inbox-test-database-contracts.ts';
import { createAppInboxTestDatabase } from '../app-inbox-test-database.ts';
import type { FakeRuntimeStateRepository } from '../fake-runtime-state-repository.ts';

export interface AuthInboxTestHarness {
    readonly queue: TestResourceInbox;
    readonly results: TestResourceInboxResults;
    readonly reader: InboxQueueReader;
    readonly service: AppAuthInboxService;
}

export interface AuthInboxTestRuntime extends AuthInboxTestHarness {
    readonly credentialIssuer: AuthCredentialIssuer;
    readonly database: AppInboxTestDatabase;
}

interface CreateAuthInboxTestRuntimeInput {
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly serviceId: string;
    readonly credentialSecret: string;
    readonly databaseOptions?: AppInboxTestDatabaseOptions;
    readonly credentialIssuer?: AuthCredentialIssuer;
    readonly nowEpochMs?: () => number;
}

interface RunAuthInboxCommandInput<Result> {
    readonly pending: Promise<Either<AppInboxFailure, Result>>;
    readonly queue: TestResourceInbox;
    readonly reader: InboxQueueReader;
    readonly minimumEntries?: number;
}

const RESOURCE_INBOX_ENTRY_EVENT = 'resource-inbox-entry';
const RESOURCE_INBOX_ENTRY_WAIT_TIMEOUT_MS = 2_000;

export class TestResourceInbox extends InMemoryQueueBox {
    private readonly materializations = new Map<string, Promise<ResourceEntry>>();
    private readonly entryEvents = new EventTarget();
    private nextMaterializationGate: Promise<void> | undefined;

    delayNextMaterializationUntil(gate: Promise<void>): void {
        this.nextMaterializationGate = gate;
    }

    async waitForEntryCount(
        minimumEntries: number,
        timeoutMs = RESOURCE_INBOX_ENTRY_WAIT_TIMEOUT_MS
    ): Promise<void> {
        const waitAbort = new AbortController();
        const timeout = rejectResourceInboxEntryWaitAfter(
            waitAbort.signal,
            timeoutMs,
            minimumEntries
        );
        try {
            while (true) {
                const entryWritten = new Promise<void>((resolve) => {
                    this.entryEvents.addEventListener(
                        RESOURCE_INBOX_ENTRY_EVENT,
                        () => resolve(),
                        { once: true, signal: waitAbort.signal }
                    );
                });
                if ((await this.getAllKeys()).length >= minimumEntries) {
                    return;
                }
                await Promise.race([entryWritten, timeout]);
            }
        }
        finally {
            waitAbort.abort();
        }
    }

    async isEntryWithStatus(key: Key, statuses: EntityStatus[]): Promise<boolean> {
        const entry = await this.getItem(key);
        return entry !== undefined && statuses.includes(entry.status);
    }

    override async enqueueIfAbsent(entry: ResourceEntry): Promise<ResourceEntry> {
        const enqueued = await super.enqueueIfAbsent(entry);
        this.entryEvents.dispatchEvent(new Event(RESOURCE_INBOX_ENTRY_EVENT));
        return enqueued;
    }

    async findAllByTopicAndResourceId(
        topicId: string,
        resourceId: string
    ): Promise<readonly ResourceEntry[]> {
        return (await readEntries(this)).filter(
            (entry) =>
                !isExpiredResourceEntry(entry) &&
                entry.key.topicId === topicId &&
                entry.key.resourceId === resourceId
        );
    }

    async writeMaterializedIfAbsentOrReplaceExpired(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const key = toKeyAsString(placeholder.key);
        const active = this.materializations.get(key);
        if (active) {
            return await active;
        }

        const pending = this.materializeEntry(placeholder, materialize);
        this.materializations.set(key, pending);
        try {
            return await pending;
        }
        finally {
            this.materializations.delete(key);
        }
    }

    private async materializeEntry(
        placeholder: ResourceEntry,
        materialize: () => Promise<ResourceEntry>
    ): Promise<ResourceEntry> {
        const existing = await this.getItem(placeholder.key);
        if (existing) {
            return existing;
        }
        const gate = this.nextMaterializationGate;
        this.nextMaterializationGate = undefined;
        await gate;
        const materialized = await materialize();
        const entry = { ...placeholder, resource: materialized.resource };
        return await this.enqueueIfAbsent(entry);
    }
}

export class TestResourceInboxResults {
    private readonly data = new Map<string, ResourceEntry>();

    replace(entry: ResourceEntry): Promise<ResourceEntry> {
        this.data.set(toKeyAsString(entry.key), entry);
        return Promise.resolve(entry);
    }

    findByKey(key: Key): Promise<ResourceEntry | undefined> {
        const entry = this.data.get(toKeyAsString(key));
        return Promise.resolve(
            entry === undefined || isExpiredResourceEntry(entry) ? undefined : entry
        );
    }

    allEntries(): ResourceEntry[] {
        return [...this.data.values()];
    }
}

export function createAuthInboxTestHarness(
    runtime: FakeRuntimeStateRepository,
    serviceId = 'auth-test-service'
): AuthInboxTestHarness {
    return createAuthInboxTestRuntime({
        runtimeRepository: runtime,
        serviceId,
        credentialSecret: `${serviceId}-secret-0123456789abcdef`
    });
}

export function createAuthInboxTestRuntime({
    runtimeRepository,
    serviceId,
    credentialSecret,
    databaseOptions,
    credentialIssuer: credentialIssuerInput,
    nowEpochMs
}: CreateAuthInboxTestRuntimeInput): AuthInboxTestRuntime {
    const queue = new TestResourceInbox();
    const results = new TestResourceInboxResults();
    const reader = new InboxQueueReader(queue);
    const credentialIssuer = credentialIssuerInput ??
        createHmacAuthCredentialIssuer(credentialSecret);
    const database = createAppInboxTestDatabase(queue, results, {
        ...databaseOptions,
        runtimeRepository
    });
    const service = new AppAuthInboxService(
        {
            inboxQueueReader: reader,
            resourceInboxRepository: queue,
            resourceInboxResultsRepository: results,
            database: database,
            authMutationService: createAuthMutationService({ runtimeRepository, serviceId }),
            credentialIssuer: credentialIssuer
        },
        {
            serviceId: serviceId,
            authFactNowEpochMs: nowEpochMs
        }
    );
    return { queue, results, reader, service, credentialIssuer, database };
}

export function createAuthInboxTestResilience(firstRetryDelayMs?: number): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    const resilienceArguments = [
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1
    ] as const;
    if (firstRetryDelayMs === undefined) {
        return ResilienceDto.toResilienceDto(...resilienceArguments);
    }
    return ResilienceDto.toResilienceDto(...resilienceArguments, 10, {
        maxAttempts: 20,
        delaysAfterAttemptMs: [firstRetryDelayMs],
        maxDelayMs: firstRetryDelayMs,
        jitterRatio: 0,
        staleDueThresholdMs: 30_000
    });
}

export async function readEntries(queue: InMemoryQueueBox): Promise<ResourceEntry[]> {
    const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));
    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

export async function waitForAuthInboxEntry(
    queue: TestResourceInbox,
    minimumEntries = 1
): Promise<void> {
    await queue.waitForEntryCount(minimumEntries);
}

export async function runAuthInboxCommand<Result>({
    pending,
    queue,
    reader,
    minimumEntries = 1
}: RunAuthInboxCommandInput<Result>): Promise<Either<AppInboxFailure, Result>> {
    await waitForAuthInboxEntry(queue, minimumEntries);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAuthInboxTestResilience()
    );
    return await pending;
}

function rejectResourceInboxEntryWaitAfter(
    abortSignal: AbortSignal,
    timeoutMs: number,
    minimumEntries: number
): Promise<never> {
    return new Promise((_, reject) => {
        const timeout = setTimeout(
            () =>
                reject(
                    new Error(
                        `ResourceInbox test queue did not reach ${minimumEntries} entries`
                    )
                ),
            timeoutMs
        );
        abortSignal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
    });
}
