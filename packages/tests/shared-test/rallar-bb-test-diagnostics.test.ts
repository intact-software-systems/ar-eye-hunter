import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxBrowserTestRuntime,
    createRallarBlackBoxTestRuntime,
    normalizeRallarBlackBoxRuntimeDiagnostic,
    selectRallarBlackBoxDiagnostics,
    type RallarBlackBoxTestWaitResultValue
} from '../../shared-test/rallar-bb-test/mod.ts';

describe('rallar-bb-test runtime diagnostics', () => {
    it('normalizes transport diagnostics so wait and assert can match them', async () => {
        const runtime = createRallarBlackBoxTestRuntime();
        runtime.recordEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.ws.unhandled_message',
            transport: 'ws',
            severity: 'warning',
            payload: normalizeRallarBlackBoxRuntimeDiagnostic({
                topic: 'rallar.browser.ws.unhandled_message',
                transport: 'ws',
                severity: 'warning',
                message: 'Unhandled WS message: room.unknown',
                data: {
                    typeId: 'room.unknown',
                    payload: {
                        text: 'ignored'
                    }
                },
                source: 'unit-test'
            })
        });

        const waitResult = await runtime.execute({
            kind: 'wait',
            commandId: 'wait-ws-warning',
            match: {
                kind: 'diagnostic',
                topic: 'rallar.browser.ws.unhandled_message',
                transport: 'ws',
                severity: 'warning',
                payloadPath: 'diagnosticTypeId',
                equals: 'rallar.browser.ws.unhandled_message'
            }
        });
        const assertResult = await runtime.execute({
            kind: 'assert',
            commandId: 'assert-ws-warning',
            source: 'recentDiagnostics.0.payload.data.typeId',
            operator: 'equals',
            expected: 'room.unknown'
        });

        expect(waitResult.ok).toBe(true);
        expect((waitResult.value as RallarBlackBoxTestWaitResultValue).event?.payload).toMatchObject({
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rallar.browser.ws.unhandled_message',
            topic: 'rallar.browser.ws.unhandled_message',
            transport: 'ws',
            severity: 'warning',
            message: 'Unhandled WS message: room.unknown',
            data: {
                typeId: 'room.unknown'
            }
        });
        expect(assertResult.ok).toBe(true);
    });

    it('normalizes browser Rallar RTC warning events from the adapter bridge', () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime();

        runtime.receiveRallarBrowserEvent({
            kind: 'diagnostic',
            topic: 'rallar.browser.rtc.data_channel_label_mismatch',
            connection: 'aliceRtc',
            transport: 'realtime',
            peerId: 'alice-session',
            remotePeerId: 'bob-session',
            data: {
                expectedDataChannelName: 'rtc-realtime',
                actualDataChannelName: 'rtc-data-channel'
            }
        });

        const diagnostic = selectRallarBlackBoxDiagnostics(runtime.state())[0];
        expect(diagnostic).toMatchObject({
            topic: 'rallar.browser.rtc.data_channel_label_mismatch',
            connection: 'aliceRtc',
            transport: 'realtime',
            severity: 'warning'
        });
        expect(diagnostic.payload).toMatchObject({
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rallar.browser.rtc.data_channel_label_mismatch',
            peerId: 'alice-session',
            remotePeerId: 'bob-session',
            data: {
                expectedDataChannelName: 'rtc-realtime',
                actualDataChannelName: 'rtc-data-channel'
            }
        });
    });

    it('normalizes browser-adapter RTC send failures as structured diagnostics', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => ({
                    status: 'no-peers',
                    peerIds: ['bob-session'],
                    health: []
                }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true })
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'send-without-peer',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                data: {
                    text: 'hello'
                }
            }
        });
        const diagnostic = selectRallarBlackBoxDiagnostics(runtime.state())
            .find((event) => event.topic === 'rallar.bb.rtc.send_failed');

        expect(result.status).toBe('failed');
        expect(diagnostic?.payload).toMatchObject({
            diagnosticSchemaVersion: 1,
            diagnosticTypeId: 'rallar.bb.rtc.send_failed',
            commandId: 'send-without-peer',
            connection: 'aliceRtc',
            transport: 'realtime',
            severity: 'error',
            message: 'RTC send resolved no target peers.',
            data: {
                status: 'no-peers',
                peerIds: ['bob-session']
            },
            error: {
                code: 'RALLAR_BB_RTC_NO_PEERS'
            }
        });
    });
});
