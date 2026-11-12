import { writeFile } from 'node:fs/promises';

import { installRtcRttSystemTopic } from '@shared-server/rallar-system/rtc-rtt/topic/install-rtc-rtt-system-topic.ts';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import {
    AppTopics,
    ConnectionContext,
    createDefaultWsQueueBoxServerService,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALEventRoute,
    newALUntargetedMessage,
    type ALMessage
} from '@shared/mod.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

interface RtcRttTrafficArgs {
    readonly sessions: number;
    readonly out: string;
}

interface RtcRttTrafficMetricsArtifact {
    readonly createdAt: string;
    readonly input: RtcRttTrafficInput;
    readonly measurements: RtcRttTrafficMeasurements;
}

interface RtcRttTrafficInput {
    readonly sessionCount: number;
    readonly submittedRttCount: number;
}

interface RtcRttTrafficMeasurements {
    readonly durableEnqueueCount: number;
    readonly enqueuedVersions: readonly number[];
}

class RtcRttTrafficWebSocket implements ConnectionContext.Socket {
    readonly readyState = WebSocket.OPEN;

    close(): void {}

    send(): number {
        return 1;
    }
}

function parseArgs(args: readonly string[]): RtcRttTrafficArgs {
    const sessions = Number(findArgValue(args, 'sessions') ?? '10');
    if (!Number.isSafeInteger(sessions) || sessions < 2) {
        throw new TypeError('--sessions must be a safe integer of at least 2');
    }
    return {
        sessions,
        out: findArgValue(args, 'out') ?? 'tmp/perf/results/rtc-rtt-traffic-metrics.json'
    };
}

function findArgValue(args: readonly string[], name: string): string | undefined {
    const prefix = `--${name}=`;
    return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
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

const ENQUEUE_SETTLE_ATTEMPT_LIMIT = 500;

/** Ingress admits and returns; the mutation it enqueues lands on the runtime's own delivery turn. */
async function readSettledEnqueues(
    enqueued: readonly RttMeasurementInfo[],
    expectedCount: number
): Promise<readonly RttMeasurementInfo[]> {
    for (let attempt = 0; attempt < ENQUEUE_SETTLE_ATTEMPT_LIMIT && enqueued.length < expectedCount; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return enqueued;
}

function createArtifact(
    createdAt: string,
    input: RtcRttTrafficInput,
    enqueuedMeasurements: readonly RttMeasurementInfo[]
): RtcRttTrafficMetricsArtifact {
    return {
        createdAt,
        input,
        measurements: {
            durableEnqueueCount: enqueuedMeasurements.length,
            enqueuedVersions: enqueuedMeasurements
                .map((measurement) => measurement.version)
                .toSorted((left, right) => left - right)
        }
    };
}

const args = parseArgs(process.argv.slice(2));

const sessionIds = Array.from(
    { length: args.sessions },
    (_, index) => `session-${String(index + 1).padStart(3, '0')}`
);
const senderSessionId = sessionIds[0];
const server = new JsonWebSocketServer();
const diagnosticConnections = new WeakSet<ConnectionContext>();
const connections = new Map(sessionIds.map((id) => {
    const connection = new ConnectionContext({ id, socket: new RtcRttTrafficWebSocket() });
    diagnosticConnections.add(connection);
    server.registerConnection(connection);
    return [id, connection] as const;
}));

const service = createDefaultWsQueueBoxServerService({
    inboundVolatileStores: undefined,
    outbox: new InMemoryQueueBox(new Map()),
    socket: server,
    name: 'rtc-rtt-traffic-diagnostic',
    readAuthenticatedConnectionScope: (connection) =>
        diagnosticConnections.has(connection) && server.connections.get(connection.id) === connection
            ? {
                scope: { applicationId: 'rtc-rtt-traffic', workspaceId: 'diagnostic' },
                expiresAtEpochMs: Number.MAX_SAFE_INTEGER
            }
            : undefined
});
const enqueuedMeasurements: RttMeasurementInfo[] = [];
installRtcRttSystemTopic(service, {
    enqueueMutation: (input) => {
        enqueuedMeasurements.push(input.rtt);
        return Promise.resolve(toResourceEntry('APP_INBOX', input));
    }
});

const measurements = createCentralRttMeasurements(sessionIds, senderSessionId);
for (const measurement of measurements) {
    await server.dispatchConnectionMessage(
        connections.get(measurement.sessionIdFrom)!,
        JSON.stringify(newALUntargetedMessage(
            measurement.sessionIdFrom,
            newALEventRoute(AppTopics.rtt, measurement.sessionIdFrom, `rtt-${measurement.version}`),
            AppTopics.rtt,
            measurement
        ))
    );
}

await writeFile(
    args.out,
    `${
        JSON.stringify(
            createArtifact(
                new Date().toISOString(),
                { sessionCount: args.sessions, submittedRttCount: measurements.length },
                await readSettledEnqueues(enqueuedMeasurements, measurements.length)
            ),
            null,
            2
        )
    }\n`
);
console.log(`Wrote ${args.out}`);

service.dispose();
