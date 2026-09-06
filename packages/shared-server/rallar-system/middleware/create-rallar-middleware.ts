import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { assembleRallarMiddlewareRuntime } from './assemble-rallar-middleware-runtime.ts';
import { createRallarMiddlewareInboxServices } from './create-rallar-middleware-inbox-services.ts';
import { createRallarMiddlewareInfrastructure } from './create-rallar-middleware-infrastructure.ts';
import type { CreateRallarMiddlewareOptions } from './rallar-middleware-construction.ts';
import { createRallarMiddlewareQueueRegistration } from './rallar-middleware-queue-registration.ts';
import type { RallarMiddlewareRuntime } from './rallar-middleware-runtime.ts';

export function createRallarMiddleware(
    options: CreateRallarMiddlewareOptions
): RallarMiddlewareRuntime {
    const queueEngine = new InboxOutboxEngine();
    const queueRegistration = createRallarMiddlewareQueueRegistration(queueEngine);
    const infrastructure = createRallarMiddlewareInfrastructure(
        options,
        queueEngine
    );
    const inboxServices = createRallarMiddlewareInboxServices(options, infrastructure);
    const registeredQueue = queueRegistration.registerExactTasks({
        wsQBoxServerService: infrastructure.wsQBoxServerService,
        inboxQueueReader: infrastructure.inboxQueueReader,
        outboxQueueReader: infrastructure.outboxQueueReader,
        wsInboxResilience: options.resilience.inbox,
        wsOutboxResilience: options.resilience.outbox ?? options.resilience.inbox,
        appInboxResilience: infrastructure.appInboxResilience,
        appOutboxResilience: infrastructure.appOutboxResilience
    });
    return assembleRallarMiddlewareRuntime({
        options,
        queueRegistration,
        infrastructure,
        inboxServices,
        registeredQueue
    });
}
