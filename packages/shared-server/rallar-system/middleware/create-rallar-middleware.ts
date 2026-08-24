import { assembleRallarMiddlewareRuntime } from './assemble-rallar-middleware-runtime.ts';
import { createRallarMiddlewareInboxServices } from './create-rallar-middleware-inbox-services.ts';
import { createRallarMiddlewareInfrastructure } from './create-rallar-middleware-infrastructure.ts';
import type { CreateRallarMiddlewareOptions } from './rallar-middleware-construction.ts';
import { createRallarMiddlewareQueueConstruction } from './rallar-middleware-queue-construction.ts';
import type { RallarMiddlewareRuntime } from './rallar-middleware-runtime.ts';
import { registerRallarMiddlewareQueueTasks } from './register-rallar-middleware-queue-tasks.ts';

export function createRallarMiddleware(
    options: CreateRallarMiddlewareOptions
): RallarMiddlewareRuntime {
    const queueConstruction = createRallarMiddlewareQueueConstruction();
    const infrastructure = createRallarMiddlewareInfrastructure(
        options,
        () => queueConstruction.wake()
    );
    const inboxServices = createRallarMiddlewareInboxServices(options, infrastructure);
    const queueTaskRegistration = registerRallarMiddlewareQueueTasks({
        options,
        queueTaskRegistration: queueConstruction.beginTaskRegistration(),
        infrastructure,
        inboxServices
    });
    return assembleRallarMiddlewareRuntime({
        options,
        queueConstruction,
        infrastructure,
        inboxServices,
        queueTaskRegistration
    });
}
