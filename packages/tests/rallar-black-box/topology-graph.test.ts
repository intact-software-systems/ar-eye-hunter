import { describe, expect, it } from 'vitest';
import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestState,
} from '../../shared-test/rallar-bb-test/types.ts';
import {
    deriveRallarTopologyGraph,
    visibleTopologyCounts,
} from '../../../apps/rallar-black-box/src/topology-graph.ts';

function baseState(events: readonly RallarBlackBoxTestEvent[]): RallarBlackBoxTestState {
    return {
        status: 'completed',
        currentConfig: {
            runId: 'run-1',
            agentId: 'agent-1',
            actor: 'alice',
            sessionId: 'alice-session',
            roomId: 'room-1',
            transport: 'realtime',
            defaults: {
                connection: 'aliceRtc',
            },
        },
        commandHistory: [],
        events,
        failures: [],
        resultCache: {},
    };
}

describe('rallar-black-box topology graph', () => {
    it('derives room, session, connection, and route topology from runtime events', () => {
        const topology = deriveRallarTopologyGraph(baseState([
            {
                eventId: 'event-connect',
                kind: 'diagnostic',
                topic: 'rallar.bb.fake.rtc.connected',
                atEpochMs: 100,
                connection: 'aliceRtc',
                actor: 'alice',
                transport: 'realtime',
                severity: 'info',
                payload: {
                    roomId: 'room-1',
                    sessionId: 'alice-session',
                    observedClients: ['alice-session', 'bob-session'],
                },
            },
            {
                eventId: 'event-message',
                kind: 'message',
                topic: 'rallar.bb.fake.rtc.message',
                atEpochMs: 120,
                commandId: 'send-1',
                connection: 'aliceRtc',
                actor: 'alice',
                transport: 'realtime',
                severity: 'info',
                payload: {
                    senderId: 'alice-session',
                    peerIds: ['bob-session'],
                    data: {
                        topic: 'manual.message',
                        text: 'hello',
                    },
                },
            },
        ]));

        expect(topology.graph.hasNode('room:room-1')).toBe(true);
        expect(topology.graph.hasNode('session:alice-session')).toBe(true);
        expect(topology.graph.hasNode('session:bob-session')).toBe(true);
        expect(topology.graph.hasEdge('route:session:alice-session->session:bob-session')).toBe(true);
        expect(topology.summary).toMatchObject({
            rooms: 1,
            sessions: 2,
            routes: 1,
            failedNodes: 0,
        });
    });

    it('marks failed diagnostics and failed visible counts', () => {
        const topology = deriveRallarTopologyGraph(baseState([
            {
                eventId: 'event-failed',
                kind: 'diagnostic',
                topic: 'rallar.browser.connect.phase_failed',
                atEpochMs: 100,
                connection: 'aliceRtc',
                actor: 'alice',
                transport: 'realtime',
                severity: 'error',
                payload: {
                    roomId: 'room-1',
                    sessionId: 'alice-session',
                    error: {
                        message: 'channel timeout',
                    },
                },
            },
        ]));

        expect(topology.summary.failedNodes).toBeGreaterThan(0);
        expect(topology.summary.failedEdges).toBeGreaterThan(0);
        expect(visibleTopologyCounts(topology.graph, 'failed').nodes).toBe(topology.summary.failedNodes);
        expect(visibleTopologyCounts(topology.graph, 'all')).toEqual({
            nodes: topology.graph.order,
            edges: topology.graph.size,
        });
    });

    it('derives routes from real browser received-message events', () => {
        const topology = deriveRallarTopologyGraph(baseState([
            {
                eventId: 'event-browser-realtime',
                kind: 'message',
                topic: 'rallar.browser.realtime.message',
                atEpochMs: 140,
                commandId: 'send-alice-bob',
                connection: 'bobRtc',
                actor: 'bob',
                transport: 'realtime',
                severity: 'info',
                payload: {
                    roomId: 'room-1',
                    peerId: 'bob-session',
                    remotePeerId: 'alice-session',
                    data: {
                        smokeId: 'two-agent-realtime',
                    },
                },
            },
            {
                eventId: 'event-browser-messages-rtc',
                kind: 'message',
                topic: 'rallar.browser.messages.rtc.message',
                atEpochMs: 160,
                commandId: 'send-bob-alice',
                connection: 'aliceRtc',
                actor: 'alice',
                transport: 'messages.rtc',
                severity: 'info',
                payload: {
                    roomId: 'room-1',
                    peerId: 'alice-session',
                    remotePeerId: 'bob-session',
                    senderId: 'bob-session',
                    data: {
                        smokeId: 'two-agent-messages-rtc',
                    },
                },
            },
        ]));

        expect(topology.graph.hasEdge('route:session:alice-session->session:bob-session')).toBe(true);
        expect(topology.graph.hasEdge('route:session:bob-session->session:alice-session')).toBe(true);
        expect(topology.summary).toMatchObject({
            rooms: 1,
            sessions: 2,
            routes: 2,
            failedNodes: 0,
        });
    });
});
