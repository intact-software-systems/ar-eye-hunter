import type {
    CreateRallarMiddlewareOptions,
    RallarMiddlewareInboxServices,
    RallarMiddlewareInfrastructure
} from './rallar-middleware-construction.ts';

export function createRallarMiddlewareInboxServices(
    options: CreateRallarMiddlewareOptions,
    infrastructure: RallarMiddlewareInfrastructure
): RallarMiddlewareInboxServices {
    const {
        inboxQueueReader,
        outboxQueueReader,
        wsQBoxServerService,
        appInboxResilience,
        appOutboxResilience,
        wakeQueueEngine
    } = infrastructure;
    return {
        groupStateInboxService: options.createGroupStateInboxService({
            inboxQueueReader,
            outboxQueueReader,
            wsQBoxServerService,
            appInboxResilience,
            appOutboxResilience,
            wakeQueueEngine
        }),
        topologyInboxService: options.createTopologyInboxService({
            inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        rtcRttInboxService: options.createRtcRttInboxService({
            inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        appClientInboxService: options.createAppClientInboxService({
            inboxQueueReader,
            wsQBoxServerService,
            appInboxResilience,
            wakeQueueEngine
        }),
        appAuthInboxService: options.createAppAuthInboxService?.({
            inboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        appAdminInboxService: options.createAppAdminInboxService?.({
            inboxQueueReader,
            outboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        }),
        appCrdtInboxService: options.createAppCrdtInboxService?.({
            inboxQueueReader,
            outboxQueueReader,
            appInboxResilience,
            wakeQueueEngine
        })
    };
}
