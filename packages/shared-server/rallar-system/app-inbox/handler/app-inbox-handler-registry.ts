import type { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import type { AppInboxType } from '../app-inbox-contracts.ts';
import type { AppInboxHandlerExecutor } from './app-inbox-handler-executor.ts';
import type { AppInboxHandlerRegistration } from './app-inbox-handler-registration.ts';

export namespace AppInboxHandlerRegistry {
    export interface Dependencies {
        readonly inboxQueueReader: InboxQueueReader;
        readonly handlerExecutor: AppInboxHandlerExecutor;
    }

    export interface Config {
        readonly serviceId: string;
    }
}

export class AppInboxHandlerRegistry {
    private readonly inboxQueueReader: InboxQueueReader;
    private readonly handlerExecutor: AppInboxHandlerExecutor;
    private readonly serviceId: string;
    private readonly registeredTypes = new Set<AppInboxType>();

    constructor(
        dependencies: AppInboxHandlerRegistry.Dependencies,
        config: AppInboxHandlerRegistry.Config
    ) {
        this.inboxQueueReader = dependencies.inboxQueueReader;
        this.handlerExecutor = dependencies.handlerExecutor;
        this.serviceId = config.serviceId;
    }

    registerHandler<Command, Result>(
        registration: AppInboxHandlerRegistration<Command, Result>
    ): void {
        if (this.registeredTypes.has(registration.type)) {
            throw new Error(
                `AppInbox handler ${registration.type} is already registered by ${this.serviceId}`
            );
        }
        this.inboxQueueReader.onInboxMessageDo(registration.type, {
            onMessage: async (message, entry) => {
                await this.handlerExecutor.execute(registration, message, entry);
            }
        });
        this.registeredTypes.add(registration.type);
    }

    assertRegistrationComplete(expectedTypes: readonly AppInboxType[]): void {
        const missing = expectedTypes.filter((type) => !this.registeredTypes.has(type));
        const unexpected = [...this.registeredTypes].filter(
            (type) => !expectedTypes.includes(type)
        );
        if (missing.length > 0 || unexpected.length > 0) {
            throw new Error(
                `AppInbox handler registration for ${this.serviceId} is incomplete: ` +
                    `missing=${missing.join(',') || 'none'}; ` +
                    `unexpected=${unexpected.join(',') || 'none'}`
            );
        }
    }
}
