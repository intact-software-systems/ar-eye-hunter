import type { JsonWebSocketServer } from '@shared/websocket/JsonWebSocketServer.ts';
import type {
    RtcTopologyPublication,
    RtcTopologyPublicationRepository,
} from '../repositories/RtcTopologyPublicationRepository.ts';

export const RTC_TOPOLOGY_PUBLICATION_CHANNEL = 'rallar_rtc_topology_publication';

export type RtcTopologyPublicationNotification = Readonly<{
    v: 1;
    publisherId: string;
    publicationId: string;
    sourceGroupStateRevision: number;
}>;

export type RtcTopologyClusterTransport = Readonly<{
    publish(
        channel: string,
        notification: RtcTopologyPublicationNotification,
    ): Promise<void>;
    subscribe(
        channel: string,
        listener: (
            notification: RtcTopologyPublicationNotification,
        ) => void | Promise<void>,
    ): Promise<void>;
}>;

export type LocalRtcTopologyClusterBus = Readonly<{
    listenersByChannel: Map<
        string,
        Set<(notification: RtcTopologyPublicationNotification) => void | Promise<void>>
    >;
}>;

const defaultLocalBus = createLocalRtcTopologyClusterBus();

export function createLocalRtcTopologyClusterBus(): LocalRtcTopologyClusterBus {
    return { listenersByChannel: new Map() };
}

export function createLocalRtcTopologyClusterTransport(
    bus: LocalRtcTopologyClusterBus = defaultLocalBus,
): RtcTopologyClusterTransport {
    return {
        publish: async (channel, notification) => {
            const listeners = bus.listenersByChannel.get(channel);
            if (!listeners) {
                return;
            }
            for (const listener of [...listeners]) {
                await listener(notification);
            }
        },
        subscribe: async (channel, listener) => {
            let listeners = bus.listenersByChannel.get(channel);
            if (!listeners) {
                listeners = new Set();
                bus.listenersByChannel.set(channel, listeners);
            }
            listeners.add(listener);
        },
    };
}

export function createDisabledRtcTopologyClusterTransport(): RtcTopologyClusterTransport {
    return {
        publish: async () => {},
        subscribe: async () => {},
    };
}

export type RtcTopologyPublicationFanout = Readonly<{
    readiness: Promise<void>;
    publish(publication: RtcTopologyPublication): Promise<number>;
    deliverLocal(publication: RtcTopologyPublication): number;
}>;

export function createRtcTopologyPublicationFanout(options: Readonly<{
    publisherId: string;
    repository: RtcTopologyPublicationRepository;
    transport: RtcTopologyClusterTransport;
    server: JsonWebSocketServer;
    channel?: string;
}>): RtcTopologyPublicationFanout {
    const channel = options.channel ?? RTC_TOPOLOGY_PUBLICATION_CHANNEL;
    const deliverLocal = (publication: RtcTopologyPublication): number => {
        const recipients = new Set(publication.recipientSessionIds);
        return options.server.broadcast(
            publication.message,
            (connection) => recipients.has(connection.id),
        );
    };
    const readiness = options.transport.subscribe(
        channel,
        async (notification) => {
            if (!isRtcTopologyPublicationNotification(notification) ||
                notification.publisherId === options.publisherId) {
                return;
            }
            const publication = await options.repository.findPublication(
                notification.publicationId,
            );
            if (!publication || publication.sourceGroupStateRevision !==
                notification.sourceGroupStateRevision) {
                return;
            }
            deliverLocal(publication);
        },
    );

    return {
        readiness,
        deliverLocal,
        publish: async (publication) => {
            const localRecipientCount = deliverLocal(publication);
            await options.transport.publish(channel, {
                v: 1,
                publisherId: options.publisherId,
                publicationId: publication.publicationId,
                sourceGroupStateRevision: publication.sourceGroupStateRevision,
            });
            return localRecipientCount;
        },
    };
}

export function isRtcTopologyPublicationNotification(
    value: unknown,
): value is RtcTopologyPublicationNotification {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const notification = value as Partial<RtcTopologyPublicationNotification>;
    return notification.v === 1 &&
        typeof notification.publisherId === 'string' &&
        typeof notification.publicationId === 'string' &&
        typeof notification.sourceGroupStateRevision === 'number';
}
