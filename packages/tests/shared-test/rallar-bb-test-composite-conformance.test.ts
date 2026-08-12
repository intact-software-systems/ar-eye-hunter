import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxBrowserTestRuntime,
    createRallarBlackBoxCompositeConformanceMatrix,
    createRallarBlackBoxTestRuntime,
    formatJsonSchemaValidationErrors,
    RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_CASES,
    RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_PROVIDERS,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
    toRallarBlackBoxCompositeConformanceReport,
    validateJsonSchema,
    type RallarBlackBoxCompositeConformanceMatrixEntry,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestCommandOutcome,
} from '../../shared-test/rallar-bb-test/mod.ts';

function expectValidRecipe(entry: RallarBlackBoxCompositeConformanceMatrixEntry): void {
    const validation = validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, entry.recipe);
    expect(
        validation.ok,
        validation.ok ? undefined : formatJsonSchemaValidationErrors(validation.errors),
    ).toBe(true);
}

function createDeterministicConformanceRuntime() {
    let now = 1_000;
    return createRallarBlackBoxTestRuntime({
        now: () => now,
        sleep: async ms => {
            now += ms;
        },
        commandExecutor: (command, context) => {
            const startedAtEpochMs = now;
            if (command.kind === 'rtc.connect') {
                now += 2;
                context.recordEvent({
                    kind: 'diagnostic',
                    topic: 'rallar.bb.rtc.connected',
                    commandId: command.commandId,
                    connection: command.connection,
                    actor: command.actor,
                    transport: command.transport,
                    severity: 'info',
                    payload: {
                        connected: true,
                        commandId: command.commandId,
                    },
                });
                return okOutcome(command, {
                    connected: true,
                    durationMs: now - startedAtEpochMs,
                });
            }

            if (command.kind === 'rtc.send') {
                now += command.commandId?.includes('negative-no-peer') ? 3 : 4;
                if (command.commandId?.includes('negative-no-peer')) {
                    const error = {
                        code: 'RALLAR_BB_RTC_NO_PEERS',
                        message: 'RTC send resolved no target peers.',
                        details: {
                            accessToken: 'secret-negative-token',
                        },
                    };
                    context.recordEvent({
                        kind: 'diagnostic',
                        topic: 'rallar.bb.rtc.send_failed',
                        commandId: command.commandId,
                        connection: command.connection,
                        transport: command.transport,
                        severity: 'error',
                        payload: {
                            error,
                        },
                    });
                    return {
                        status: 'failed',
                        value: {
                            status: 'no-peers',
                            sendObservation: {
                                commandId: command.commandId,
                                kind: command.kind,
                                transport: command.transport,
                                durationMs: now - startedAtEpochMs,
                                ok: false,
                                status: 'no-peers',
                                errorCode: error.code,
                            },
                        },
                        error,
                        nextStatus: 'failed',
                    };
                }

                context.recordEvent({
                    kind: 'message',
                    topic: 'rallar.conformance.message',
                    commandId: command.commandId,
                    connection: command.connection,
                    transport: command.transport,
                    payload: toMessagePayload(command),
                });
                return okOutcome(command, {
                    sent: command.send,
                    sendObservation: {
                        commandId: command.commandId,
                        kind: command.kind,
                        transport: command.transport,
                        durationMs: now - startedAtEpochMs,
                        ok: true,
                        status: 'sent',
                    },
                });
            }

            if (command.kind === 'ws.open') {
                now += 1;
                return okOutcome(command, {
                    connection: command.connection,
                    opened: true,
                });
            }

            if (command.kind === 'ws.send') {
                now += 2;
                context.recordEvent({
                    kind: 'message',
                    topic: 'rallar.bb.ws.message',
                    commandId: command.commandId,
                    connection: command.connection,
                    transport: 'ws',
                    payload: {
                        data: command.data,
                    },
                });
                return okOutcome(command, {
                    connection: command.connection,
                    sent: command.data,
                    sendObservation: {
                        commandId: command.commandId,
                        kind: command.kind,
                        transport: 'ws',
                        durationMs: now - startedAtEpochMs,
                        ok: true,
                        status: 'sent',
                    },
                });
            }

            if (command.kind === 'ws.close') {
                now += 1;
                context.recordEvent({
                    kind: 'event',
                    topic: 'rallar.bb.ws.closed',
                    commandId: command.commandId,
                    connection: command.connection,
                    transport: 'ws',
                    payload: {
                        closed: true,
                    },
                });
                return okOutcome(command, {
                    connection: command.connection,
                    closed: true,
                });
            }

            return undefined;
        },
    });
}

function okOutcome(
    command: RallarBlackBoxTestCommand & Readonly<{ commandId: string }>,
    value: unknown,
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'ok',
        value,
        nextStatus: command.kind === 'close' ? 'idle' : undefined,
    };
}

function toMessagePayload(command: Extract<RallarBlackBoxTestCommand, { kind: 'rtc.send' }>): unknown {
    const send = command.send;
    if (send && typeof send === 'object' && !Array.isArray(send)) {
        const record = send as Record<string, unknown>;
        return {
            data: record.data ?? record.payload ?? send,
        };
    }
    return {
        data: send,
    };
}

describe('rallar-bb-test composite conformance matrix', () => {
    it('defines representative cases and skip-safe provider entries', () => {
        expect(RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_CASES.map(entry => entry.caseId)).toEqual([
            'looped-rtc-send',
            'parallel-ws-rtc-groups',
            'wait-assert-evidence',
            'cancel-during-loop',
            'wait-absence-hold',
            'wait-absence-violated',
            'assert-shape-complete-violated',
            'negative-no-peer',
        ]);
        expect(RALLAR_BLACK_BOX_COMPOSITE_CONFORMANCE_PROVIDERS.map(entry => entry.providerId)).toEqual([
            'in-memory-local',
            'browser-rallar',
            'remote-browser-control',
        ]);

        const matrix = createRallarBlackBoxCompositeConformanceMatrix({
            recipeOptions: {
                recipeIdPrefix: 'test-composite-conformance',
            },
        });

        expect(matrix).toHaveLength(24);
        expect(new Set(matrix.map(entry => entry.entryId)).size).toBe(matrix.length);
        matrix.forEach(entry => {
            expect(entry.supported).toBe(true);
            expect(entry.artifactName).toBe(entry.entryId.replace(/:/g, '-'));
            expectValidRecipe(entry);
        });

        const liveEntries = matrix.filter(entry => entry.mode === 'live-gated');
        expect(liveEntries.length).toBeGreaterThan(0);
        liveEntries.forEach(entry => {
            expect(entry.requires?.env).toContain('RALLAR_API_BASE_URL');
            expect(entry.requires?.httpServices?.length).toBeGreaterThan(0);
        });

        const remoteEntries = matrix.filter(entry => entry.providerId === 'remote-browser-control');
        remoteEntries.forEach(entry => {
            expect(entry.requires?.env).toContain('RALLAR_BLACK_BOX_CONTROL_BASE_URL');
            expect(entry.requires?.env).toContain('RALLAR_BLACK_BOX_AGENT_ID');
            expect(entry.requires?.controlServer).toBe(true);
        });
    });

    it('passes all deterministic local composite conformance cases', async () => {
        const entries = createRallarBlackBoxCompositeConformanceMatrix({
            providerIds: ['in-memory-local'],
            recipeOptions: {
                recipeIdPrefix: 'local-composite-conformance',
            },
        });

        for (const entry of entries) {
            const runtime = createDeterministicConformanceRuntime();
            const result = await runtime.execute({
                kind: 'recipe.run',
                commandId: `run-${entry.caseId}`,
                recipe: entry.recipe,
            });
            const report = toRallarBlackBoxCompositeConformanceReport(entry, {
                result,
                state: runtime.state(),
                redaction: {
                    keys: ['accessToken'],
                },
            });

            expect(report.status, entry.caseId).toBe('passed');
            expect(report.observed?.resultStatus).toBe(entry.case.expectedStatus);
            expect(report.observed?.commandKinds).toEqual(expect.arrayContaining(entry.case.requiredCommandKinds));
            expect(report.observed?.eventTopics).toEqual(expect.arrayContaining(entry.case.requiredEventTopics ?? []));
        }
    });

    it('runs a browser-adapter loop conformance entry and keeps its artifact compact', async () => {
        let now = 5_000;
        let sendCount = 0;
        const [entry] = createRallarBlackBoxCompositeConformanceMatrix({
            providerIds: ['browser-rallar'],
            caseIds: ['looped-rtc-send'],
        });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            now: () => now,
            sleep: async ms => {
                now += ms;
            },
            rallarRuntime: {
                connect: async () => {
                    now += 2;
                    return { connected: true };
                },
                send: async () => {
                    sendCount += 1;
                    now += 3;
                    return { status: 'sent', frame: sendCount };
                },
                sendWs: async () => ({ status: 'sent' }),
                refreshRoom: async () => undefined,
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true }),
            },
        });

        const result = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'run-browser-loop-conformance',
            recipe: entry.recipe,
        });
        runtime.receiveRallarBrowserEvent({
            kind: 'message',
            topic: 'rallar.conformance.message',
            connection: 'conformanceRtc',
            transport: 'realtime',
            data: {
                topic: 'rallar.conformance.looped-rtc-send',
            },
        });
        const report = toRallarBlackBoxCompositeConformanceReport(entry, {
            result,
            state: runtime.state(),
        });

        expect(report.status).toBe('passed');
        expect(sendCount).toBe(3);
        expect(report.observed?.compositeSummary).toMatchObject({
            composite: 1,
            failed: 0,
        });
        expect(JSON.stringify(report)).not.toContain('"results"');
    });

    it('redacts failure artifacts while preserving expected no-peer evidence', async () => {
        const [entry] = createRallarBlackBoxCompositeConformanceMatrix({
            providerIds: ['in-memory-local'],
            caseIds: ['negative-no-peer'],
        });
        const runtime = createDeterministicConformanceRuntime();
        const result = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'run-negative-no-peer',
            recipe: entry.recipe,
        });
        const report = toRallarBlackBoxCompositeConformanceReport(entry, {
            result,
            state: runtime.state(),
            redaction: {
                keys: ['accessToken'],
            },
        });

        expect(report.status).toBe('passed');
        expect(report.observed?.failureCodes).toContain('RALLAR_BB_RTC_NO_PEERS');
        expect(JSON.stringify(report)).toContain('<redacted>');
        expect(JSON.stringify(report)).not.toContain('secret-negative-token');
    });
});
