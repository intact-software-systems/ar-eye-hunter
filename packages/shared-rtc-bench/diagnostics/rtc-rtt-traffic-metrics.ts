import { installRtcRttSystemTopic } from '@shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import {
    AppTopics,
    ConnectionContext,
    createDefaultWsQueueBoxServerService,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALEventRoute,
    type ALMessage
} from '@shared/mod.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { createDeterministicRtcTopologyGroupSnapshot } from '../workloads/topology/create-deterministic-rtc-topology-group-snapshot.ts';

interface RtcRttTrafficArgs {
    readonly sessions: number;
    readonly out: string;
}

interface RtcRttTrafficMetricsArtifact {
    readonly createdAt: string;
    readonly input: {
        readonly sessionCount: number;
        readonly submittedRttCount: number;
    };
    readonly measurements: {
        readonly durableEnqueueCount: number;
        readonly enqueuedVersions: readonly number[];
    };
}

class RtcRttTrafficWebSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = WebSocket.OPEN;
    readonly url = 'ws://rtc-rtt-traffic-diagnostic';
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;
    private readonly messageListeners: EventListenerOrEventListenerObject[] = [];

    override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
    ): void {
        super.addEventListener(type, callback, options);
        if (type === 'message' && callback !== null) {
            this.messageListeners.push(callback);
        }
    }

    close(): void {}

    send(): void {}

    async receive(message: ALMessage): Promise<void> {
        const event = new MessageEvent('message', { data: JSON.stringify(message) });
        for (const listener of this.messageListeners) {
            if (typeof listener === 'function') {
                await listener.call(this, event);
            }
            else {
                await listener.handleEvent(event);
            }
        }
    }
}

function parseArgs(): RtcRttTrafficArgs {
    const sessions = Number(readArgValue('sessions', '10'));
    if (!Number.isSafeInteger(sessions) || sessions < 2) {
        throw new TypeError('--sessions must be a safe integer of at least 2');
    }
    return {
        sessions,
        out: readArgValue('out', 'tmp/perf/results/rtc-rtt-traffic-metrics.json')
    };
}

function readArgValue(name: string, fallback: string): string {
    const prefix = `--${name}=`;
    return Deno.args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function createCentralRttMeasurements(
    sessionIds: readonly string[],
    centralSessionId: string
): readonly RttMeasurementInfo[] {
    const measurements: RttMeasurementInfo[] = [];
    let version = 1;

    for (let leftIndex = 0; leftIndex < sessionIds.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < sessionIds.length; rightIndex++) {
            const from = sessionIds[leftIndex];
            const to = sessionIds[rightIndex];
            measurements.push({
                sessionIdFrom: from,
                sessionIdTo: to,
                rttMs: from === centralSessionId || to === centralSessionId ? 1 : 100,
                createdAtEpochMs: version,
                version: version++
            });
        }
    }

    return measurements;
}

function createArtifact(
    sessionCount: number,
    submittedRttCount: number,
    enqueuedMeasurements: readonly RttMeasurementInfo[]
): RtcRttTrafficMetricsArtifact {
    return {
        createdAt: new Date().toISOString(),
        input: {
            sessionCount,
            submittedRttCount
        },
        measurements: {
            durableEnqueueCount: enqueuedMeasurements.length,
            enqueuedVersions: enqueuedMeasurements
                .map((measurement) => measurement.version)
                .toSorted((left, right) => left - right)
        }
    };
}

const args = parseArgs();

const sessionIds = Array.from(
    { length: args.sessions },
    (_, index) => `session-${String(index + 1).padStart(3, '0')}`
);
const senderSessionId = sessionIds[0];
const senderSocket = new RtcRttTrafficWebSocket();
const server = new JsonWebSocketServer();
server.addConnection(new ConnectionContext(senderSessionId, senderSocket));

const service = createDefaultWsQueueBoxServerService({
    inbox: new InMemoryQueueBox(new Map()),
    outbox: new InMemoryQueueBox(new Map()),
    socket: server,
    name: 'rtc-rtt-traffic-diagnostic'
});
const group = createDeterministicRtcTopologyGroupSnapshot('room-1', sessionIds, Date.now());
const enqueuedMeasurements: RttMeasurementInfo[] = [];
installRtcRttSystemTopic(service, {
    enqueueMutation: (input) => {
        enqueuedMeasurements.push(input.rtt);
        return Promise.resolve(toResourceEntry('APP_INBOX', input));
    }
});

const measurements = createCentralRttMeasurements(sessionIds, senderSessionId);
for (const measurement of measurements) {
    await senderSocket.receive(
        newALBroadcastMessage(
            senderSessionId,
            newALEventRoute(AppTopics.rtt, group.group.groupId, `rtt-${measurement.version}`),
            'room',
            AppTopics.rtt,
            measurement,
            { groupRef: group.group }
        )
    );
}

await Deno.writeTextFile(
    args.out,
    `${
        JSON.stringify(
            createArtifact(args.sessions, measurements.length, enqueuedMeasurements),
            null,
            2
        )
    }\n`
);
console.log(`Wrote ${args.out}`);
