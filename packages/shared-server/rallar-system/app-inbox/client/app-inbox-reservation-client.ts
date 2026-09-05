import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { Key, ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { validateAppInboxCommandIdentity } from '../app-inbox-command-identity.ts';
import {
    AppInboxIdempotencyConflictError,
    AppInboxReservationConflictError,
    type AppInboxEnqueueInput,
    type AppInboxMessageContext
} from '../app-inbox-contracts.ts';
import { toAppInboxResourceEntry } from '../app-inbox-queue-entry.ts';

export namespace AppInboxReservationClient {
    export interface MaterializedReservation {
        readonly enqueue: AppInboxEnqueueInput;
        readonly key: Key;
        readonly winner: boolean;
    }

    export interface Repository {
        replaceIfObserved(
            expected: ResourceEntry,
            replacement: ResourceEntry
        ): Promise<ResourceEntry | null>;
        writeMaterializedIfAbsentOrReplaceExpired(
            placeholder: ResourceEntry,
            materialize: () => Promise<ResourceEntry>
        ): Promise<ResourceEntry>;
    }

    export interface Dependencies {
        readonly repository: Repository;
    }

    export interface Config {
        readonly serviceId: string;
    }
}

export class AppInboxReservationClient {
    private readonly repository: AppInboxReservationClient.Repository;
    private readonly serviceId: string;

    constructor(
        dependencies: AppInboxReservationClient.Dependencies,
        config: AppInboxReservationClient.Config
    ) {
        this.repository = dependencies.repository;
        this.serviceId = config.serviceId;
    }

    async persistAuthority<Result>(
        context: AppInboxMessageContext<Result>,
        authority: JsonWireValue
    ): Promise<void> {
        const enqueue = { ...context.enqueue, authority };
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
        const result = await this.repository.replaceIfObserved(context.entry, replacement);
        if (result === null) {
            throw new AppInboxReservationConflictError(context.entry.key);
        }
    }

    async reserveMaterializedEntry(
        placeholder: AppInboxEnqueueInput,
        materialize: () => Promise<AppInboxEnqueueInput>
    ): Promise<AppInboxReservationClient.MaterializedReservation> {
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
            key: entry.key,
            winner
        };
    }
}
