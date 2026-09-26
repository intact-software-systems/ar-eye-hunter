import { request, type APIRequestContext } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/live-rtc-control-client.ts';
import {
    normalizeJson,
    numberValue,
    optionalJsonArray,
    requiredJsonRecord,
    requiredString,
    type LiveRtcJsonRecord
} from '../../../tests/playwright/rallar-black-box/live-rtc-evidence-json.ts';
import type { LiveRtcSignalingObservation } from '../../../tests/playwright/rallar-black-box/live-rtc-signaling-observation.ts';

interface RawSignalingObservation extends LiveRtcSignalingObservation.Snapshot {
    readonly sdp: string;
    readonly token: string;
}

interface ReadinessFailureArtifactRead {
    readonly serialized: string;
    readonly sidecar: LiveRtcJsonRecord;
}

const SENTINEL = 'SENTINEL-secret-readiness-evidence';
const ARTIFACT_FILE_NAME = 'live-rtc-readiness-failure-agent-a-temporal.json';

const BEFORE_FINAL_SIGNALING_CUT = {
    runCaptureSucceeded: true,
    causalOrdinalScope: 'retained-event-tail',
    causalEventCoverage: {
        runEventCount: 205,
        relevantEventCount: 205,
        retainedEventCount: 200,
        projectionTruncated: true
    }
};

const FORWARD_PHASE_TIMES = [1_001, 1_002, 1_003, 1_004, 1_005, 1_006, 1_007] as const;

describe('live RTC readiness failure diagnostic order', () => {
    let api: APIRequestContext;
    let agent: LiveRtcControlClient.WaitForRtcReadinessInput['agent'];
    let control: LiveRtcControlClient;
    let diagnosticsRoot: string;
    let events: LiveRtcControlClient.Event[];
    let failTerminalRun: boolean;
    let failFinalSignaling: boolean;
    let epochReadings: number[];
    let epochMs: number;
    let finalSignalingReadStarted: boolean;
    let hasReadInitialSignaling: boolean;
    let server: Server;

    const readinessFailure = new Error('original readiness failure');
    beforeEach(async () => {
        diagnosticsRoot = mkdtempSync(
            path.join(tmpdir(), 'live-rtc-readiness-order-')
        );
        events = Array.from(
            { length: 205 },
            (_, index) =>
                toDiagnosticEvent({
                    atEpochMs: index,
                    topic: 'rallar.browser.rtc.lifecycle',
                    data: {
                        kind: 'peer-created',
                        peerId: 'session-b',
                        payload: SENTINEL
                    }
                })
        );
        failTerminalRun = false;
        failFinalSignaling = false;
        epochReadings = [];
        epochMs = 1_000;
        finalSignalingReadStarted = false;
        hasReadInitialSignaling = false;
        agent = {
            agentId: 'agent-a',
            prefix: 'A',
            refreshRoom: async () => {
                throw readinessFailure;
            },
            readSignalingObservation: async () => {
                if (!hasReadInitialSignaling) {
                    hasReadInitialSignaling = true;
                    return toInitialSignalingObservation();
                }
                finalSignalingReadStarted = true;
                if (failFinalSignaling) {
                    throw new Error(SENTINEL);
                }
                events.push(...toFinalSignalingCausalEvents());
                return toFinalSignalingObservation();
            }
        };
        const results: LiveRtcControlClient.Result[] = [];
        server = createServer(async (incoming, response) => {
            if (incoming.method === 'POST') {
                const command = await readCommand(incoming);
                const commandId = requiredString(command.commandId, '$.commandId');
                results.push({
                    agentId: 'agent-a',
                    commandId,
                    ok: true,
                    result: {
                        value: {
                            rallar: {
                                rtcStatus: { readyPeerIds: [], knownPeerIds: ['session-b'] },
                                rtcDiagnostics: {
                                    sessionId: 'session-a',
                                    generatedAtEpochMs: 300,
                                    peers: []
                                }
                            }
                        }
                    }
                });
                response.writeHead(202).end('{}');
                return;
            }
            if (failTerminalRun && finalSignalingReadStarted) {
                response.writeHead(503).end(SENTINEL);
                return;
            }
            response
                .writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ agents: [{ agentId: 'agent-a' }], results, events }));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected a local control HTTP port.');
        }
        api = await request.newContext();
        control = new LiveRtcControlClient({
            request: api,
            baseUrl: `http://127.0.0.1:${address.port}`,
            diagnosticsOutDir: diagnosticsRoot,
            monotonicNow: () => 0,
            epochNow: () => epochReadings.shift() ?? ++epochMs
        });
    });

    afterEach(async () => {
        await api.dispose();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        rmSync(diagnosticsRoot, { recursive: true, force: true });
    });

    it('brackets the final signaling read with causal cuts', async () => {
        await expect(captureReadinessFailure(control, agent)).rejects.toBe(
            readinessFailure
        );

        const { serialized, sidecar } = readReadinessFailureArtifact(diagnosticsRoot);
        const initialSignaling = requiredAgentSignaling(
            sidecar.signalingByAgentId
        );
        const causalCutBeforeFinalSignaling = requiredCausalCut(sidecar, 'causalCutBeforeFinalSignaling');
        const causalCutAfterFinalSignaling = requiredCausalCut(sidecar, 'causalCutAfterFinalSignaling');
        const finalSignaling = requiredAgentSignaling(
            sidecar.finalSignalingByAgentId
        );

        expect(sidecar.runCaptureSucceeded).toBe(true);
        expect(sidecar.causalOrdinalScope).toBe('retained-event-tail');
        expect(optionalJsonArray(sidecar.causalEvents, '$.sidecar.causalEvents'))
            .toHaveLength(200);
        expect(JSON.stringify(sidecar.causalEvents)).not.toContain('answer-message');
        expect(initialSignaling).toMatchObject({
            available: true,
            received: [],
            droppedReceived: 0,
            droppedAttempts: 0,
            droppedNativeLifetimes: 0,
            attempts: [],
            nativeLifetimes: []
        });
        expect(causalCutBeforeFinalSignaling).toMatchObject(BEFORE_FINAL_SIGNALING_CUT);
        expect(JSON.stringify(causalCutBeforeFinalSignaling.causalEvents)).not.toContain('answer-message');
        expect(causalCutAfterFinalSignaling).toMatchObject({
            runCaptureSucceeded: true,
            causalOrdinalScope: 'retained-event-tail',
            causalEventCoverage: {
                runEventCount: 207,
                relevantEventCount: 207,
                retainedEventCount: 200,
                projectionTruncated: true
            }
        });
        expect(optionalJsonArray(causalCutAfterFinalSignaling.causalEvents, '$.after.causalEvents').slice(-2))
            .toMatchObject([
                {
                    kind: 'admission-outcome',
                    msgId: 'answer-message',
                    outcome: 'committed'
                },
                {
                    kind: 'claim-settled',
                    msgId: 'answer-message',
                    payloadKind: 'dispatch-local',
                    outcome: 'completed'
                }
            ]);
        expect(optionalJsonArray(finalSignaling.received, '$.final.received'))
            .toHaveLength(128);
        expect(optionalJsonArray(finalSignaling.attempts, '$.final.attempts'))
            .toHaveLength(128);
        expect(optionalJsonArray(finalSignaling.nativeLifetimes, '$.final.nativeLifetimes'))
            .toHaveLength(128);
        expect(finalSignaling).toMatchObject({
            available: true,
            droppedReceived: 7,
            droppedAttempts: 8,
            droppedNativeLifetimes: 9
        });
        expect(optionalJsonArray(finalSignaling.received, '$.final.received').at(-1))
            .toMatchObject({ msgId: 'answer-message', signalType: 'Answer' });
        expect(optionalJsonArray(finalSignaling.attempts, '$.final.attempts').at(-1))
            .toMatchObject({
                msgId: 'answer-message',
                nativeInstanceOrdinal: 130,
                match: 'unique',
                settlement: 'applied'
            });
        expect(optionalJsonArray(finalSignaling.nativeLifetimes, '$.final.nativeLifetimes').at(-1))
            .toMatchObject({
                nativeInstanceOrdinal: 130,
                observation: 'live'
            });
        expect(toObservationTimes(sidecar)).toEqual(FORWARD_PHASE_TIMES);
        expect(serialized).not.toMatch(
            /SENTINEL|secret-|"(?:sdp|token|credentials|payload)"\s*:/u
        );
    });

    it('writes bounded unavailable final evidence without replacing the readiness failure', async () => {
        failTerminalRun = true;
        failFinalSignaling = true;

        await expect(captureReadinessFailure(control, agent)).rejects.toBe(
            readinessFailure
        );

        const { serialized, sidecar } = readReadinessFailureArtifact(diagnosticsRoot);
        const causalCutBeforeFinalSignaling = requiredCausalCut(sidecar, 'causalCutBeforeFinalSignaling');
        const causalCutAfterFinalSignaling = requiredCausalCut(sidecar, 'causalCutAfterFinalSignaling');
        const finalSignaling = requiredAgentSignaling(
            sidecar.finalSignalingByAgentId
        );

        expect(sidecar.runCaptureSucceeded).toBe(true);
        expect(causalCutBeforeFinalSignaling).toMatchObject(BEFORE_FINAL_SIGNALING_CUT);
        expect(causalCutAfterFinalSignaling).toMatchObject({
            runCaptureSucceeded: false,
            causalOrdinalScope: 'retained-event-tail',
            causalEventCoverage: {
                runEventCount: 0,
                relevantEventCount: 0,
                retainedEventCount: 0,
                projectionTruncated: false
            },
            causalEvents: []
        });
        expect(finalSignaling).toEqual({
            available: false,
            received: [],
            attempts: [],
            droppedReceived: 0,
            droppedAttempts: 0,
            nativeLifetimes: [],
            droppedNativeLifetimes: 0
        });
        expect(toObservationTimes(sidecar)).toEqual(FORWARD_PHASE_TIMES);
        expect(serialized).not.toContain(SENTINEL);
    });

    it('keeps phase completion times nondecreasing when the epoch clock regresses', async () => {
        epochReadings = [1_001, 999, 1_003, 1_002, 1_000, 1_004, 998];

        await expect(captureReadinessFailure(control, agent)).rejects.toBe(
            readinessFailure
        );

        const { sidecar } = readReadinessFailureArtifact(diagnosticsRoot);

        expect(toObservationTimes(sidecar)).toEqual([
            1_001,
            1_001,
            1_003,
            1_003,
            1_003,
            1_004,
            1_004
        ]);
    });
});

async function captureReadinessFailure(
    control: LiveRtcControlClient,
    agent: LiveRtcControlClient.WaitForRtcReadinessInput['agent']
): Promise<number> {
    return await control.waitForPeerReadiness({
        runId: 'run-temporal',
        agent,
        participantAgents: [agent],
        expectedPeerIds: ['session-b'],
        suffix: 'temporal',
        startedAtMs: 0
    });
}

function readReadinessFailureArtifact(diagnosticsRoot: string): ReadinessFailureArtifactRead {
    const serialized = readFileSync(
        path.join(diagnosticsRoot, ARTIFACT_FILE_NAME),
        'utf8'
    );
    return {
        serialized,
        sidecar: requiredJsonRecord(normalizeJson(JSON.parse(serialized)), '$.sidecar')
    };
}

function requiredCausalCut(
    sidecar: LiveRtcJsonRecord,
    key: 'causalCutBeforeFinalSignaling' | 'causalCutAfterFinalSignaling'
): LiveRtcJsonRecord {
    return requiredJsonRecord(sidecar[key], `$.sidecar.${key}`);
}

async function readCommand(
    incoming: IncomingMessage
): Promise<LiveRtcJsonRecord> {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
        chunks.push(Buffer.from(chunk));
    }
    return requiredJsonRecord(
        normalizeJson(JSON.parse(Buffer.concat(chunks).toString())),
        '$.command'
    );
}

function toInitialSignalingObservation(): RawSignalingObservation {
    return {
        available: true,
        received: [],
        attempts: [],
        droppedReceived: 0,
        droppedAttempts: 0,
        nativeLifetimes: [],
        droppedNativeLifetimes: 0,
        sdp: SENTINEL,
        token: SENTINEL
    };
}

function toFinalSignalingObservation(): RawSignalingObservation {
    return {
        available: true,
        received: Array.from({ length: 130 }, (_, index) => ({
            msgId: index === 129 ? 'answer-message' : `received-${index}`,
            signalType: 'Answer' as const,
            offerId: 'offer-1',
            fromId: 'session-b',
            toId: 'session-a',
            receivedAtEpochMs: 250 + index
        })),
        attempts: Array.from({ length: 130 }, (_, index) => ({
            msgId: index === 129 ? 'answer-message' : `received-${index}`,
            signalType: 'Answer' as const,
            offerId: 'offer-1',
            fromId: 'session-b',
            toId: 'session-a',
            receivedAtEpochMs: 250 + index,
            nativeInstanceOrdinal: index + 1,
            match: 'unique' as const,
            attemptedAtEpochMs: 400 + index,
            settledAtEpochMs: 500 + index,
            settlement: 'applied' as const,
            state: nativeState()
        })),
        droppedReceived: 5,
        droppedAttempts: 6,
        nativeLifetimes: Array.from({ length: 130 }, (_, index) => ({
            nativeInstanceOrdinal: index + 1,
            createdAtEpochMs: 200 + index,
            creationState: nativeState(),
            closedAtEpochMs: null,
            closeState: null,
            observedAtEpochMs: 600 + index,
            observation: 'live' as const,
            state: nativeState()
        })),
        droppedNativeLifetimes: 7,
        sdp: SENTINEL,
        token: SENTINEL
    };
}

function nativeState(): LiveRtcSignalingObservation.NativeState {
    return {
        signalingState: 'stable',
        connectionState: 'new',
        iceConnectionState: 'new'
    };
}

function toFinalSignalingCausalEvents(): readonly LiveRtcControlClient.Event[] {
    return [
        toDiagnosticEvent({
            atEpochMs: 300,
            topic: 'rallar.browser.alm.inbound_diagnostics',
            data: {
                kind: 'admission-outcome',
                typeId: 'rtc-signaling',
                msgId: 'answer-message',
                outcome: 'committed',
                credentials: SENTINEL
            }
        }),
        toDiagnosticEvent({
            atEpochMs: 301,
            topic: 'rallar.browser.alm.inbound_diagnostics',
            data: {
                kind: 'claim-settled',
                workerId: 'worker-1',
                msgId: 'answer-message',
                typeId: null,
                payloadKind: 'dispatch-local',
                outcome: 'completed',
                attempts: 1,
                durationMs: 3,
                queueWaitMs: 2,
                payload: SENTINEL
            }
        })
    ];
}

function toDiagnosticEvent(input: {
    readonly atEpochMs: number;
    readonly topic: string;
    readonly data: LiveRtcJsonRecord;
}): LiveRtcControlClient.Event {
    return {
        kind: 'diagnostic',
        agentId: 'agent-a',
        payload: {
            eventId: `event-${input.atEpochMs}`,
            kind: 'diagnostic',
            topic: input.topic,
            atEpochMs: input.atEpochMs,
            severity: 'info',
            payload: {
                diagnosticSchemaVersion: 1,
                diagnosticTypeId: input.topic,
                topic: input.topic,
                severity: 'info',
                message: input.topic,
                atEpochMs: input.atEpochMs,
                data: input.data
            }
        }
    };
}

function requiredAgentSignaling(
    value: LiveRtcJsonRecord[string] | undefined
): LiveRtcJsonRecord {
    return requiredJsonRecord(
        requiredJsonRecord(value, '$.signalingByAgentId')['agent-a'],
        '$.signalingByAgentId.agent-a'
    );
}

function toObservationTimes(sidecar: LiveRtcJsonRecord): readonly (number | undefined)[] {
    const observationTimes = requiredJsonRecord(
        sidecar.observationTimes,
        '$.sidecar.observationTimes'
    );
    return [
        numberValue(observationTimes.initialRunCompletedAtEpochMs),
        numberValue(observationTimes.initialSignalingCompletedAtEpochMs),
        numberValue(observationTimes.healthCompletedAtEpochMs),
        numberValue(observationTimes.causalCutBeforeFinalSignalingCompletedAtEpochMs),
        numberValue(observationTimes.finalSignalingCompletedAtEpochMs),
        numberValue(observationTimes.causalCutAfterFinalSignalingCompletedAtEpochMs),
        numberValue(sidecar.capturedAtEpochMs)
    ];
}
