import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { createAuthMutationService } from '@shared-server/rallar-system/auth/auth-mutation-service.ts';
import { createHmacAuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import type { AuthCredentialIssuer } from '@shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts';
import { AppAuthInboxService } from '@shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';

import {
    createAppInboxTestResilience,
    TestResourceInbox,
    TestResourceInboxResults
} from '../rallar-system/app-inbox/test-support/app-inbox-resource-fixtures.ts';
import type { AppInboxTestDatabase, AppInboxTestDatabaseOptions } from '../rallar-system/app-inbox/test-support/app-inbox-test-database-contracts.ts';
import { createAppInboxTestDatabase } from '../rallar-system/app-inbox/test-support/app-inbox-test-database.ts';
import type { FakeRuntimeStateRepository } from '../runtime-state/test-support/fake-runtime-state-repository.ts';

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

export async function runAuthInboxCommand<Result>({
    pending,
    queue,
    reader,
    minimumEntries = 1
}: RunAuthInboxCommandInput<Result>): Promise<Either<AppInboxFailure, Result>> {
    await queue.waitForEntryCount(minimumEntries);
    await reader.dequeueInbox(
        InboxQueueReader.INBOX_DEQUEUE_TYPES,
        createAppInboxTestResilience()
    );
    return await pending;
}
