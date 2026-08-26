import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { JsonWireValue } from '../protocol/json-wire-identity.ts';
import { decodeAppInboxEnqueue } from './app-inbox-command-decoding.ts';
import { validateAppInboxCommandIdentity } from './app-inbox-command-identity.ts';
import {
    AppInboxIdempotencyConflictError,
    AppInboxReservationConflictError,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from './app-inbox-contracts.ts';
import { toAppInboxResourceEntry } from './app-inbox-queue-entry.ts';

export interface MaterializedAppInboxReservation {
    readonly enqueue: AppInboxEnqueueInput<JsonWireValue>;
    readonly winner: boolean;
}

export namespace AppInboxReservationClient {
    export interface Repository {
        writeMaterializedIfAbsentOrReplaceExpired(
            placeholder: ResourceEntry,
            materialize: () => Promise<ResourceEntry>
        ): Promise<ResourceEntry>;
    }

    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly repository: Repository;
    }

    export interface Config {
        readonly serviceId: string;
    }
}

export class AppInboxReservationClient {
    private readonly inbox: InboxQueueReader;
    private readonly repository: AppInboxReservationClient.Repository;
    private readonly serviceId: string;

    constructor(
        dependencies: AppInboxReservationClient.Dependencies,
        config: AppInboxReservationClient.Config
    ) {
        this.inbox = dependencies.inboxQueueReader;
        this.repository = dependencies.repository;
        this.serviceId = config.serviceId;
    }

    async persistAuthority<Authority, Result>(
        context: AppInboxMessageContext<Result>,
        authority: Authority
    ): Promise<void> {
        const enqueue = decodeAppInboxEnqueue({ ...context.enqueue, authority });
        const message: ALMessage = {
            ...context.message,
            payload: {
                ...context.message.payload,
                resource: JSON.stringify(enqueue)
            }
        };
        const replacement: ResourceEntry = {
            ...context.entry,
            resource: JSON.stringify(message)
        };
        const result = await this.inbox.inbox.enqueueOrUpdate(
            replacement,
            (existing) =>
                existing.status === EntityStatus.RESERVED &&
                    existing.dequeueAudit.attempts === context.entry.dequeueAudit.attempts &&
                    existing.resource === context.entry.resource
                    ? replacement
                    : undefined
        );
        if (result.action !== 'updated') {
            throw new AppInboxReservationConflictError(context.entry.key);
        }
    }

    async reserveMaterializedEntry<Command>(
        placeholder: AppInboxEnqueueInput<null>,
        materialize: () => Promise<AppInboxEnqueueInput<Command>>
    ): Promise<MaterializedAppInboxReservation> {
        let winner = false;
        const entry = await this.repository.writeMaterializedIfAbsentOrReplaceExpired(
            toAppInboxResourceEntry(placeholder, `${this.serviceId}:fact-reservation`),
            async () => {
                winner = true;
                return toAppInboxResourceEntry(await materialize(), this.serviceId);
            }
        );
        const validation = validateAppInboxCommandIdentity(entry);
        if (!validation.valid) {
            throw new AppInboxIdempotencyConflictError(
                entry.key.resourceId,
                'invalid-existing-command',
                'invalid-received-command'
            );
        }
        return {
            enqueue: validation.command,
            winner
        };
    }
}
