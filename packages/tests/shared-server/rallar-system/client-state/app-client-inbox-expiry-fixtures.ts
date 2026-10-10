import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import {
    NOT_COMPLETED_RETRYABLE_STATUSES,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { FakeRuntimeStateRepository } from '../../runtime-state/test-support/fake-runtime-state-repository.ts';
import type { TestResourceInbox } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';

export async function readClientExpiryTestEntries(queue: TestResourceInbox): Promise<ResourceEntry[]> {
    const entries = await Promise.all((await queue.getAllKeys()).map((key) => queue.getItem(key)));
    return entries.filter((entry): entry is ResourceEntry => entry !== undefined);
}

export function listActiveClientExpiryTestEntries(entries: readonly ResourceEntry[]): ResourceEntry[] {
    return entries.filter((entry) => NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status));
}

export function readClientExpiryTestEnqueueData<V>(entry: ResourceEntry): V {
    const message = JSON.parse(entry.resource) as { payload: { resource: string; }; };
    return (JSON.parse(message.payload.resource) as { data: V; }).data;
}

export async function createClientExpiryTestIssuedAuthority(
    runtimeRepository: FakeRuntimeStateRepository,
    clientId: string,
    sessionId: string
) {
    const authority = {
        clientId,
        accessToken: `${clientId}-token`,
        username: clientId,
        sessionId,
        issuedAtEpochMs: Date.now() - 1_000,
        expiresAtEpochMs: Date.now() + 60_000
    };
    await new AuthSessionRepository(runtimeRepository).putSession(authority);
    return authority;
}
