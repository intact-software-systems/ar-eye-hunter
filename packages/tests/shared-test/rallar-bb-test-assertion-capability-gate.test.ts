import { describe, expect, it, vi } from 'vitest';
import { decodeBlackBoxRallarCrdtOpenInput } from '../../shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts';
import type {
    RallarBlackBoxBrowserRallarConnectionConfig,
    RallarBlackBoxBrowserRallarRuntime
} from '../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { RecipeCaptureRequirements } from '../../shared-test/rallar-bb-test/recipe/recipe-capture-requirements.ts';
import { snapshotExecutableRecipe } from '../../shared-test/rallar-bb-test/recipe/snapshot-executable-recipe.ts';
import { validateExecutableRecipe } from '../../shared-test/rallar-bb-test/recipe/validate-executable-recipe.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '../../shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { createBrowserRallarRequiredMethodsTestDouble } from './browser-rallar-required-methods-test-double.ts';

import type {
    RallarBlackBoxControlAgentCandidate,
    RallarBlackBoxControlAgentCapabilities,
    RallarBlackBoxDistributedRunManifest
} from '../../shared-test/rallar-bb-test/distributed-run.ts';
import {
    computeDistributedAssertionFeatures,
    decodeControlAgentCapabilities,
    toControlAgentCapabilities
} from '../../shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts';
import {
    resolveDistributedRunTargets
} from '../../shared-test/rallar-bb-test/distributed/resolve-distributed-run-targets.ts';
import type { RallarBlackBoxTestRecipe, RallarBlackBoxTestRecord } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

const FULL_MESSAGING_CAPABILITY: RallarBlackBoxControlAgentCapabilities['messaging'] = {
    supported: true,
    carriers: ['ws', 'rtc', 'rtc-with-ws-fallback'],
    faults: true,
    storageCounters: true,
    reload: true
};

const BASELINE_ONLY_CAPABILITIES: RallarBlackBoxControlAgentCapabilities = {
    crdt: { supported: true, transports: [], apiBaseUrlConfigured: false },
    assertions: { absence: false, untilLoop: false, operators: ['equals', 'notEquals', 'contains', 'exists', 'gte', 'lte'] },
    messaging: FULL_MESSAGING_CAPABILITY
};

const NEW_FEATURE_RECIPE: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'gate-new-features',
    commands: [
        {
            kind: 'wait',
            commandId: 'gate-absence',
            absent: true,
            timeoutMs: 1_000,
            match: { kind: 'message', topic: 'room.gate.forbidden' }
        },
        {
            kind: 'loop',
            commandId: 'gate-until',
            until: 'first-success',
            count: 3,
            commands: [
                {
                    kind: 'assert',
                    commandId: 'gate-extended-assert',
                    source: 'state.commandHistory.length',
                    operator: 'gt',
                    expected: 0
                }
            ]
        }
    ]
};

const BASELINE_RECIPE: RallarBlackBoxTestRecipe = {
    schemaVersion: 1,
    recipeId: 'gate-baseline',
    commands: [
        { kind: 'health', commandId: 'gate-health' },
        {
            kind: 'assert',
            commandId: 'gate-baseline-assert',
            source: 'state.commandHistory.length',
            operator: 'gte',
            expected: 0
        }
    ]
};

function manifestWith(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxDistributedRunManifest {
    return {
        distributedRunId: `gate-${recipe.recipeId}`,
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'gate-room'
        },
        recipes: [
            {
                recipeId: recipe.recipeId,
                recipe,
                variables: {}
            }
        ],
        targetPolicy: {
            mode: 'all-online-group-members',
            expectedParticipantCount: 1
        },
        startMode: 'manual',
        schemaVersion: 1,
        controlRunId: `gate-${recipe.recipeId}`,
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
        groupAssertions: [],
        metadata: {}
    };
}

// Missing capabilities are an explicit admission input, not an invented default.
function agentWith(
    capabilities: RallarBlackBoxControlAgentCapabilities | undefined
): RallarBlackBoxControlAgentCandidate {
    return {
        agentId: 'gate-agent',
        connected: true,
        lastHeartbeatAtEpochMs: 1_000,
        identity: {
            principalId: 'gate-principal',
            sessionId: 'gate-session',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'gate-room',
            capabilities,
            updatedAtEpochMs: 1_000,
            sessionLabel: 'gate-principal:gate-session'
        }
    };
}

describe('rallar-bb-test assertion capability gate', () => {
    it.each([
        null,
        {},
        { configurationVersion: 2, modes: ['native'] },
        { configurationVersion: '1', modes: ['native'] },
        { configurationVersion: 1, modes: ['inherit'] },
        { configurationVersion: 1, modes: ['native', 'native'] },
        { configurationVersion: 1, modes: 'native' }
    ])('rejects malformed or incompatible RTC capture advertisements %j', (rtcCapture) => {
        expect(decodeControlAgentCapabilities({ ...BASELINE_ONLY_CAPABILITIES, rtcCapture }).left).toContain('rtcCapture');
    });

    it('decodes signaling-only support without inventing Native', () => {
        expect(decodeControlAgentCapabilities({ ...BASELINE_ONLY_CAPABILITIES, rtcCapture: { configurationVersion: 1, modes: ['off', 'signaling'] } }).right)
            .toMatchObject({
                rtcCapture: { configurationVersion: 1, modes: ['off', 'signaling'] }
            });
    });

    it.each(['off', 'signaling', 'native'] as const)('requires installed support for explicit %s at SDK acquisition', (mode) => {
        const manifest = { ...manifestWith({ schemaVersion: 1, recipeId: 'mode', commands: [{ kind: 'rtc.connect' }] }), rtcCaptureMode: mode };
        const resolve = (capabilities: RallarBlackBoxControlAgentCapabilities | undefined) =>
            resolveDistributedRunTargets({
                manifest,
                agents: [agentWith(capabilities)],
                nowEpochMs: 1_500,
                staleAfterMs: 30_000
            });
        expect(resolve(undefined).targetAgentIds).toEqual([]);
        expect(resolve({ ...BASELINE_ONLY_CAPABILITIES, rtcCapture: { configurationVersion: 1, modes: [mode] } }).targetAgentIds).toEqual(['gate-agent']);
        if (mode === 'native') {
            expect(resolve({ ...BASELINE_ONLY_CAPABILITIES, rtcCapture: { configurationVersion: 1, modes: ['off', 'signaling'] } }).targetAgentIds).toEqual([]);
        }
    });

    it.each([
        {
            name: 'omitted RTC intent',
            recipe: { schemaVersion: 1 as const, recipeId: 'omitted', commands: [{ kind: 'rtc.connect' as const }] },
            expected: true
        },
        {
            name: 'explicit Native Health',
            recipe: { schemaVersion: 1 as const, recipeId: 'health', rtcCaptureMode: 'native' as const, commands: [{ kind: 'health' as const }] },
            expected: true
        },
        {
            name: 'explicit Native API',
            recipe: {
                schemaVersion: 1 as const,
                recipeId: 'api',
                rtcCaptureMode: 'native' as const,
                commands: [{ kind: 'http.request' as const, request: { path: '/health' } }]
            },
            expected: true
        },
        {
            name: 'explicit Native local-only CRDT',
            recipe: {
                schemaVersion: 1 as const,
                recipeId: 'local',
                rtcCaptureMode: 'native' as const,
                commands: [{ kind: 'crdt.open' as const, name: 'local', transport: 'local-only' as const }]
            },
            expected: true
        },
        {
            name: 'explicit Native live CRDT',
            recipe: {
                schemaVersion: 1 as const,
                recipeId: 'live',
                rtcCaptureMode: 'native' as const,
                commands: [{ kind: 'crdt.open' as const, name: 'live', transport: 'ws' as const }]
            },
            expected: false
        },
        {
            name: 'Configure Native RTC',
            recipe: {
                schemaVersion: 1 as const,
                recipeId: 'configured',
                commands: [{ kind: 'configure' as const, config: { rallar: { rtcCaptureMode: 'native' } } }, { kind: 'rtc.connect' as const }]
            },
            expected: false
        },
        {
            name: 'Configure Native then omission',
            recipe: {
                schemaVersion: 1 as const,
                recipeId: 'cleared',
                commands: [{ kind: 'configure' as const, config: { rallar: { rtcCaptureMode: 'native' } } }, { kind: 'configure' as const, config: {} }, {
                    kind: 'rtc.connect' as const
                }]
            },
            expected: true
        }
    ])('admits only executable capture requirements: $name', ({ recipe, expected }) => {
        const result = resolveDistributedRunTargets({
            manifest: manifestWith(recipe),
            agents: [agentWith(undefined)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(result.targetAgentIds).toEqual(expected ? ['gate-agent'] : []);
    });

    it.each([
        {
            label: 'command nonlocal over configured local-only',
            configured: 'local-only' as const,
            command: 'ws' as const,
            transport: undefined,
            expectedTransport: 'ws',
            admitted: false
        },
        {
            label: 'command local-only over configured nonlocal',
            configured: 'ws' as const,
            command: 'local-only' as const,
            transport: undefined,
            expectedTransport: 'local-only',
            admitted: true
        },
        {
            label: 'top-level local-only over command nonlocal',
            configured: 'ws' as const,
            command: 'ws' as const,
            transport: 'local-only' as const,
            expectedTransport: 'local-only',
            admitted: true
        }
    ])('capture admission fix1 follows executable CRDT transport: $label', ({ configured, command, transport, expectedTransport, admitted }) => {
        const open = { kind: 'crdt.open' as const, name: 'owned-doc', rallar: { crdtTransport: command }, ...(transport === undefined ? {} : { transport }) };
        // The real runtime decoder independently confirms the valid execution transport.
        expect(decodeBlackBoxRallarCrdtOpenInput(open).transport).toBe(expectedTransport);
        const recipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'owned-crdt-transport',
            commands: [{ kind: 'configure', config: { rallar: { crdtTransport: configured } } }, open]
        };
        const result = resolveDistributedRunTargets({
            manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
            agents: [agentWith(undefined)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(result.targetAgentIds).toEqual(admitted ? ['gate-agent'] : []);
    });

    it('keeps parallel Configure isolated while inheriting canonical run precedence through nested recipes', () => {
        const recipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'branches',
            rtcCaptureMode: 'native',
            commands: [
                {
                    kind: 'parallel',
                    groups: [
                        { groupId: 'configured', commands: [{ kind: 'configure', config: { rallar: { rtcCaptureMode: 'off' } } }, { kind: 'rtc.connect' }] },
                        {
                            groupId: 'inherited',
                            commands: [{
                                kind: 'recipe.run',
                                rtcCaptureMode: 'signaling',
                                recipe: { schemaVersion: 1, recipeId: 'child', commands: [{ kind: 'loop', count: 2, commands: [{ kind: 'rtc.connect' }] }] }
                            }]
                        }
                    ]
                },
                { kind: 'rtc.connect' }
            ]
        };
        const resolve = (modes: RallarBlackBoxControlAgentCapabilities['rtcCapture'], run?: 'off') =>
            resolveDistributedRunTargets({
                manifest: { ...manifestWith(recipe), ...(run === undefined ? {} : { rtcCaptureMode: run }) },
                agents: [agentWith({ ...BASELINE_ONLY_CAPABILITIES, rtcCapture: modes })],
                nowEpochMs: 1_500,
                staleAfterMs: 30_000
            });
        expect(resolve({ configurationVersion: 1, modes: ['off', 'signaling'] }).targetAgentIds).toEqual([]);
        expect(resolve({ configurationVersion: 1, modes: ['off', 'signaling', 'native'] }).targetAgentIds).toEqual(['gate-agent']);
        expect(resolve({ configurationVersion: 1, modes: ['off'] }, 'off').targetAgentIds).toEqual(['gate-agent']);
    });

    it('collects absence, until, and extended operator usage from inline recipes', () => {
        const features = computeDistributedAssertionFeatures([NEW_FEATURE_RECIPE]);
        expect(features).toEqual({
            absence: true,
            untilLoop: true,
            operators: ['gt']
        });

        expect(computeDistributedAssertionFeatures([BASELINE_RECIPE])).toEqual({
            absence: false,
            untilLoop: false,
            operators: []
        });
    });

    it('blocks staging targets for agents that advertise none of the required assertion features', () => {
        const resolution = resolveDistributedRunTargets({
            manifest: manifestWith(NEW_FEATURE_RECIPE),
            agents: [agentWith(BASELINE_ONLY_CAPABILITIES)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });

        expect(resolution.targetAgentIds).toEqual([]);
        expect(resolution.blockers).toHaveLength(1);
        expect(resolution.blockers[0]).toMatchObject({
            agentId: 'gate-agent',
            status: 'missing-assertion-capability'
        });
        expect(resolution.blockers[0].reason).toContain('absence waits');
        expect(resolution.blockers[0].reason).toContain('until loops');
        expect(resolution.blockers[0].reason).toContain('assert operators: gt');
        expect(resolution.summary.assertionCapabilityBlockedAgents).toBe(1);
        expect(resolution.summary.missingExpectedParticipants).toBe(1);
    });

    it('refuses required Native RTC capture when the target advertises only neighboring capabilities', () => {
        const manifest = {
            ...manifestWith({
                schemaVersion: 1,
                recipeId: 'required-native-capture',
                commands: [{ kind: 'rtc.connect', commandId: 'required-connect' }]
            }),
            rtcCaptureMode: 'native' as const
        };
        const resolution = resolveDistributedRunTargets({
            manifest,
            agents: [agentWith(BASELINE_ONLY_CAPABILITIES)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });

        expect({
            targets: resolution.targetAgentIds,
            blockers: resolution.blockers.map((blocker) => ({
                agentId: blocker.agentId,
                mentionsCapture: blocker.reason.toLowerCase().includes('capture')
            })),
            missingExpectedParticipants: resolution.summary.missingExpectedParticipants
        }).toEqual({
            targets: [],
            blockers: [{ agentId: 'gate-agent', mentionsCapture: true }],
            missingExpectedParticipants: 1
        });
    });

    it('stages a capability-complete fleet and leaves baseline manifests ungated', () => {
        const complete = agentWith(toControlAgentCapabilities({
            config: undefined,
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080'
        }));

        const gated = resolveDistributedRunTargets({
            manifest: manifestWith(NEW_FEATURE_RECIPE),
            agents: [complete],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(gated.targetAgentIds).toEqual(['gate-agent']);
        expect(gated.blockers).toEqual([]);

        const baseline = resolveDistributedRunTargets({
            manifest: manifestWith(BASELINE_RECIPE),
            agents: [agentWith(BASELINE_ONLY_CAPABILITIES)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(baseline.targetAgentIds).toEqual(['gate-agent']);
        expect(baseline.blockers).toEqual([]);
    });

    it.each([
        {
            name: 'no assertions block',
            patch: { assertions: undefined },
            error: 'capabilities.assertions must report absence, untilLoop and operators'
        },
        {
            name: 'an assertions block without operators',
            patch: { assertions: { absence: true, untilLoop: true } },
            error: 'capabilities.assertions must report absence, untilLoop and operators'
        },
        {
            name: 'an operator the build does not know',
            patch: { assertions: { absence: true, untilLoop: true, operators: ['equals', 'resembles'] } },
            error: 'capabilities.assertions.operators must list known assert operators'
        },
        {
            name: 'a CRDT transport the build does not know',
            patch: { crdt: { supported: true, transports: ['ws', 'carrier-pigeon'], apiBaseUrlConfigured: true } },
            error: 'capabilities.crdt.transports must list known CRDT transports'
        },
        {
            name: 'a blank CRDT runtime surface',
            patch: { crdt: { supported: true, transports: ['ws'], runtimeSurface: ' ', apiBaseUrlConfigured: true } },
            error: 'capabilities.crdt.runtimeSurface must be a non-empty string when present'
        }
    ])('rejects a capability block with $name instead of reading it as absent', ({ patch, error }) => {
        const advertised = JSON.parse(JSON.stringify(toControlAgentCapabilities({
            config: undefined,
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080'
        })));

        expect(decodeControlAgentCapabilities({ ...advertised, ...patch }).left).toBe(error);
    });

    it('advertises the runtime feature set and survives the register-envelope parse', () => {
        const advertised = toControlAgentCapabilities({
            config: undefined,
            providerMode: 'browser-rallar',
            apiBaseUrl: 'http://localhost:8080'
        });
        expect(advertised.assertions).toMatchObject({
            absence: true,
            untilLoop: true
        });
        expect(advertised.assertions?.operators).toContain('matchesShapeComplete');

        const decoded = decodeControlAgentCapabilities(
            JSON.parse(JSON.stringify(advertised))
        );
        expect(decoded.right?.assertions).toEqual(advertised.assertions);
        expect(decoded.right?.crdt.supported).toBe(true);

        expect(decodeControlAgentCapabilities({ crdt: { supported: true }, messaging: FULL_MESSAGING_CAPABILITY }).left)
            .toBe('capabilities.crdt must report supported, transports and apiBaseUrlConfigured');
    });
});

describe('capture admission fix1 serialized CRDT connection input', () => {
    it('preserves command-owned transport through the ordinary recipe schema', () => {
        const recipe = JSON.parse(JSON.stringify({
            schemaVersion: 1,
            recipeId: 'serialized-crdt',
            commands: [{ kind: 'crdt.open', name: 'owned-doc', rallar: { crdtTransport: 'ws' } }]
        }));
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe).ok).toBe(true);
        expect(decodeBlackBoxRallarCrdtOpenInput(recipe.commands[0]).transport).toBe('ws');
        const result = resolveDistributedRunTargets({
            manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
            agents: [agentWith(undefined)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(result.targetAgentIds).toEqual([]);
    });

    it('requires the CRDT command capture selection that the browser execution receives', () => {
        const recipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'crdt-step-capture',
            commands: [{ kind: 'crdt.open', name: 'owned-doc', transport: 'ws', rallar: { rtcCaptureMode: 'native' } }]
        };
        const result = resolveDistributedRunTargets({
            manifest: manifestWith(recipe),
            agents: [agentWith(undefined)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(result.targetAgentIds).toEqual([]);
    });
});

it('capture admission fix1 freezes a CRDT command capture selection with its executable recipe', () => {
    const connection = { rtcCaptureMode: 'native' as const };
    const recipe = snapshotExecutableRecipe({
        schemaVersion: 1,
        recipeId: 'crdt-capture-snapshot',
        commands: [{ kind: 'crdt.open', name: 'owned-doc', transport: 'ws', rallar: connection }]
    });
    Object.assign(connection, { rtcCaptureMode: 'off' });
    expect(recipe.commands[0]).toMatchObject({ rallar: { rtcCaptureMode: 'native' } });
});

it('capture admission fix1 refuses malformed CRDT capture input through executable validation', () => {
    const recipe = JSON.parse(JSON.stringify({
        schemaVersion: 1,
        recipeId: 'malformed-crdt-capture',
        commands: [{ kind: 'crdt.open', name: 'owned-doc', rallar: { rtcCaptureMode: 'invalid' } }]
    }));
    expect(validateExecutableRecipe(recipe).length).toBeGreaterThan(0);
});

it.each([
    {
        label: 'run above Configure and step',
        run: 'native' as const,
        configured: 'off' as const,
        step: 'off' as const,
        recipeMode: undefined,
        transport: 'ws' as const,
        expected: ['native']
    },
    {
        label: 'command step above Configure',
        run: undefined,
        configured: 'native' as const,
        step: 'off' as const,
        recipeMode: undefined,
        transport: 'ws' as const,
        expected: ['off']
    },
    {
        label: 'command step above recipe',
        run: undefined,
        configured: undefined,
        step: 'native' as const,
        recipeMode: 'signaling' as const,
        transport: 'ws' as const,
        expected: ['native']
    },
    {
        label: 'Configure supplies inherited step',
        run: undefined,
        configured: 'off' as const,
        step: undefined,
        recipeMode: 'native' as const,
        transport: 'ws' as const,
        expected: ['off']
    },
    {
        label: 'omission retains absent intent',
        run: undefined,
        configured: undefined,
        step: undefined,
        recipeMode: undefined,
        transport: 'ws' as const,
        expected: []
    },
    {
        label: 'local-only requires no capture',
        run: 'native' as const,
        configured: undefined,
        step: 'native' as const,
        recipeMode: undefined,
        transport: 'local-only' as const,
        expected: []
    }
])('capture admission fix1 CRDT control: $label', ({ run, configured, step, recipeMode, transport, expected }) => {
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'crdt-capture-control',
        rtcCaptureMode: recipeMode,
        commands: [
            ...(configured === undefined ? [] : [{ kind: 'configure' as const, config: { rallar: { rtcCaptureMode: configured } } }]),
            { kind: 'crdt.open', name: 'owned-doc', transport, rallar: { rtcCaptureMode: step } }
        ]
    };
    expect(new RecipeCaptureRequirements().collect({ selections: [{ recipeId: recipe.recipeId, recipe, variables: {} }], run })).toEqual(expected);
});

it('capture admission fix1 covers a parallel sibling Configure consumed by a delayed CRDT command', async () => {
    vi.useFakeTimers();
    const observed: RallarBlackBoxTestRecord[] = [];
    const stop = async (input: RallarBlackBoxTestRecord): Promise<never> => {
        observed.push(input);
        throw new Error('Owned CRDT input observed; stop before SDK execution.');
    };
    const refuseUnexercised = async (): Promise<never> => {
        throw new Error('Unexercised owned browser method refused.');
    };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'parallel-crdt-config',
        commands: [
            { kind: 'configure', config: { rallar: { crdtTransport: 'local-only' } } },
            {
                kind: 'parallel',
                maxConcurrency: 2,
                groups: [
                    { commands: [{ kind: 'crdt.open', name: 'owned-doc', metadata: { localDelayMs: 10 } }] },
                    { commands: [{ kind: 'configure', config: { rallar: { crdtTransport: 'ws' } } }] }
                ]
            }
        ]
    };
    vi.stubGlobal('localStorage', { getItem: () => null });
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: refuseUnexercised,
            send: refuseUnexercised,
            refreshRoom: refuseUnexercised,
            close: async () => undefined,
            health: refuseUnexercised,
            crdt: { open: stop, apply: stop, read: stop, sync: stop, health: stop, wait: stop, undo: stop, redo: stop, close: stop, destroy: stop }
        }
    });
    try {
        const pending = runtime.execute({ kind: 'recipe.run', recipe, rtcCaptureMode: 'native' });
        await vi.advanceTimersByTimeAsync(10);
        const execution = await pending;
        expect(execution.ok).toBe(false);
        expect(runtime.state().commandHistory.find((result) => result.kind === 'crdt.open')?.error?.message).toBe(
            'Owned CRDT input observed; stop before SDK execution.'
        );
        expect(observed).toHaveLength(1);
        expect(decodeBlackBoxRallarCrdtOpenInput(observed[0]).transport).toBe('ws');
        expect(observed[0]).toMatchObject({ rallar: { rtcCaptureContext: { run: 'native' } } });
        const resolution = resolveDistributedRunTargets({
            manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
            agents: [agentWith(undefined)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(resolution.targetAgentIds).toEqual([]);
    }
    finally {
        await runtime.execute({ kind: 'close' });
        vi.useRealTimers();
        vi.unstubAllGlobals();
    }
});

it('capture admission fix1 covers a parallel sibling Configure selecting a delayed structured WS route', async () => {
    vi.useFakeTimers();
    const observed: {
        readonly data: Parameters<NonNullable<RallarBlackBoxBrowserRallarRuntime['sendWs']>>[0];
        readonly capture: Parameters<NonNullable<RallarBlackBoxBrowserRallarRuntime['sendWs']>>[1];
    }[] = [];
    const stop = async (): Promise<never> => {
        throw new Error('Unrequested browser operation.');
    };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'parallel-ws-config',
        commands: [
            { kind: 'configure', config: { control: { providerMode: 'simulated' } } },
            {
                kind: 'parallel',
                maxConcurrency: 2,
                groups: [
                    { commands: [{ kind: 'ws.send', data: { typeId: 'owned-message', payload: {} }, metadata: { localDelayMs: 10 } }] },
                    { commands: [{ kind: 'configure', config: { control: { providerMode: 'browser-rallar' } } }] }
                ]
            }
        ]
    };
    vi.stubGlobal('localStorage', { getItem: () => null });
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: stop,
            send: stop,
            refreshRoom: stop,
            close: async () => undefined,
            health: stop,
            sendWs: async (data, capture) => {
                observed.push({ data, capture });
                throw new Error('Owned WS route observed; stop before SDK execution.');
            }
        }
    });
    try {
        const pending = runtime.execute({ kind: 'recipe.run', recipe, rtcCaptureMode: 'native' });
        await vi.advanceTimersByTimeAsync(10);
        const execution = await pending;
        expect(execution.ok).toBe(false);
        expect(runtime.state().commandHistory.find((result) => result.kind === 'ws.send')?.error?.message).toBe(
            'Owned WS route observed; stop before SDK execution.'
        );
        expect(observed).toEqual([{
            data: { typeId: 'owned-message', payload: {} },
            capture: { rtcCaptureMode: undefined, rtcCaptureContext: { run: 'native', recipe: undefined } }
        }]);
        const resolution = resolveDistributedRunTargets({
            manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
            agents: [agentWith(undefined)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(resolution.targetAgentIds).toEqual([]);
    }
    finally {
        await runtime.execute({ kind: 'close' });
        vi.useRealTimers();
        vi.unstubAllGlobals();
    }
});

it.each([
    {
        label: 'source order at concurrency one',
        run: 'native' as const,
        concurrency: 1,
        work: { kind: 'crdt.open' as const, name: 'owned-doc' },
        update: 'ws' as const,
        reset: false,
        expected: ['gate-agent']
    },
    {
        label: 'explicit local-only command',
        run: 'native' as const,
        concurrency: 2,
        work: { kind: 'crdt.open' as const, name: 'owned-doc', transport: 'local-only' as const },
        update: 'ws' as const,
        reset: false,
        expected: ['gate-agent']
    },
    {
        label: 'known Health work',
        run: 'native' as const,
        concurrency: 2,
        work: { kind: 'health' as const },
        update: 'ws' as const,
        reset: false,
        expected: ['gate-agent']
    },
    {
        label: 'omitted capture intent',
        run: undefined,
        concurrency: 2,
        work: { kind: 'crdt.open' as const, name: 'owned-doc' },
        update: 'ws' as const,
        reset: false,
        expected: ['gate-agent']
    },
    {
        label: 'local-only Configure facts',
        run: 'native' as const,
        concurrency: 2,
        work: { kind: 'crdt.open' as const, name: 'owned-doc' },
        update: 'local-only' as const,
        reset: false,
        expected: ['gate-agent']
    },
    {
        label: 'explicit Configure reset after parallel',
        run: 'native' as const,
        concurrency: 2,
        work: { kind: 'health' as const },
        update: 'ws' as const,
        reset: true,
        expected: ['gate-agent']
    }
])('capture admission fix1 parallel shared-config control: $label', ({ run, concurrency, work, update, reset, expected }) => {
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'parallel-capture-control',
        commands: [
            { kind: 'configure', config: { rallar: { crdtTransport: 'local-only' } } },
            {
                kind: 'parallel',
                maxConcurrency: concurrency,
                groups: [
                    { commands: [work] },
                    { commands: [{ kind: 'configure', config: { rallar: { crdtTransport: update } } }] }
                ]
            },
            ...(reset
                ? [
                    { kind: 'configure' as const, config: { rallar: { crdtTransport: 'local-only' } } },
                    { kind: 'crdt.open' as const, name: 'after-reset' }
                ]
                : [])
        ]
    };
    const resolution = resolveDistributedRunTargets({
        manifest: { ...manifestWith(recipe), rtcCaptureMode: run },
        agents: [agentWith(undefined)],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual(expected);
});

it.each([
    { concurrency: 2, expected: [] },
    { concurrency: 1, expected: ['gate-agent'] }
])('retains shared configuration alternatives after parallel at concurrency $concurrency', ({ concurrency, expected }) => {
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'parallel-final-config',
        commands: [
            {
                kind: 'parallel',
                maxConcurrency: concurrency,
                groups: [
                    { commands: [{ kind: 'configure', config: { rallar: { crdtTransport: 'ws' } } }] },
                    { commands: [{ kind: 'configure', config: { rallar: { crdtTransport: 'local-only' } } }] }
                ]
            },
            { kind: 'crdt.open', name: 'after-parallel' }
        ]
    };
    const resolution = resolveDistributedRunTargets({
        manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
        agents: [agentWith(undefined)],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual(expected);
});

it('retains only the sole writer final reset after a nested concurrent block', () => {
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'nested-parallel-final-config',
        commands: [
            { kind: 'configure', config: { rallar: { crdtTransport: 'ws' } } },
            {
                kind: 'parallel',
                groups: [
                    {
                        commands: [{
                            kind: 'parallel',
                            groups: [
                                {
                                    commands: [
                                        { kind: 'configure', config: { rallar: { crdtTransport: 'ws' } } },
                                        { kind: 'configure', config: { rallar: { crdtTransport: 'local-only' } } },
                                        { kind: 'crdt.open', name: 'inside-reset' }
                                    ]
                                },
                                { commands: [{ kind: 'health' }] }
                            ]
                        }]
                    },
                    { commands: [{ kind: 'health' }] }
                ]
            },
            { kind: 'crdt.open', name: 'after-reset' }
        ]
    };
    const resolution = resolveDistributedRunTargets({
        manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
        agents: [agentWith(undefined)],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual(['gate-agent']);
});

it('requires capture when a nested sibling Configure can select nonlocal CRDT work', () => {
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'nested-parallel-crdt-config',
        commands: [{
            kind: 'parallel',
            groups: [
                { commands: [{ kind: 'crdt.open', name: 'outer-work' }] },
                {
                    commands: [{
                        kind: 'parallel',
                        groups: [
                            { commands: [{ kind: 'configure', config: { rallar: { crdtTransport: 'ws' } } }] },
                            { commands: [{ kind: 'health' }] }
                        ]
                    }]
                }
            ]
        }]
    };
    const resolution = resolveDistributedRunTargets({
        manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
        agents: [agentWith(undefined)],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual([]);
});

it('capture admission fix1 preserves sole-writer local-only reset within a concurrent CRDT branch', async () => {
    vi.useFakeTimers();
    const observed: RallarBlackBoxTestRecord[] = [];
    const stop = async (input: RallarBlackBoxTestRecord): Promise<never> => {
        observed.push(input);
        throw new Error('Owned CRDT input observed; stop before SDK execution.');
    };
    const refuseUnexercised = async (): Promise<never> => {
        throw new Error('Unexercised owned browser method refused.');
    };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'parallel-crdt-sole-writer',
        commands: [
            { kind: 'configure', config: { rallar: { crdtTransport: 'local-only' } } },
            {
                kind: 'parallel',
                maxConcurrency: 2,
                groups: [
                    {
                        commands: [
                            { kind: 'configure', config: { rallar: { crdtTransport: 'ws' } } },
                            { kind: 'configure', config: { rallar: { crdtTransport: 'local-only' } } },
                            { kind: 'crdt.open', name: 'owned-doc' }
                        ]
                    },
                    { commands: [{ kind: 'health' }] }
                ]
            }
        ]
    };
    vi.stubGlobal('localStorage', { getItem: () => null });
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: refuseUnexercised,
            send: refuseUnexercised,
            refreshRoom: refuseUnexercised,
            close: async () => undefined,
            health: async () => {
                throw new Error('Owned Health control; stop before SDK execution.');
            },
            crdt: { open: stop, apply: stop, read: stop, sync: stop, health: stop, wait: stop, undo: stop, redo: stop, close: stop, destroy: stop }
        }
    });
    try {
        const pending = runtime.execute({ kind: 'recipe.run', recipe, rtcCaptureMode: 'native' });
        await vi.advanceTimersByTimeAsync(10);
        const execution = await pending;
        expect(execution.ok).toBe(false);
        expect(runtime.state().commandHistory.find((result) => result.kind === 'crdt.open')?.error?.message).toBe(
            'Owned CRDT input observed; stop before SDK execution.'
        );
        expect(observed).toHaveLength(1);
        expect(decodeBlackBoxRallarCrdtOpenInput(observed[0]).transport).toBe('local-only');
        expect(observed[0]).toMatchObject({ rallar: { rtcCaptureContext: { run: 'native' } } });
        const resolution = resolveDistributedRunTargets({
            manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
            agents: [agentWith(undefined)],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(resolution.targetAgentIds).toEqual(['gate-agent']);
    }
    finally {
        await runtime.execute({ kind: 'close' });
        vi.useRealTimers();
        vi.unstubAllGlobals();
    }
});

it('refuses required capture when a parallel sibling replaces the loaded Health recipe during a wait', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => null });
    const observed: RallarBlackBoxBrowserRallarConnectionConfig[] = [];
    const refuseUnexercised = async (): Promise<never> => {
        throw new Error('Unexercised owned browser method refused.');
    };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'parallel-loaded-body',
        commands: [
            { kind: 'recipe.load', recipe: { schemaVersion: 1, recipeId: 'loaded-health', commands: [{ kind: 'health' }] } },
            {
                kind: 'parallel',
                maxConcurrency: 2,
                groups: [
                    {
                        commands: [
                            { kind: 'wait', commandId: 'owned-absence', absent: true, timeoutMs: 10, match: { kind: 'message', topic: 'owned.never' } },
                            { kind: 'recipe.run' }
                        ]
                    },
                    { commands: [{ kind: 'recipe.load', recipe: { schemaVersion: 1, recipeId: 'loaded-rtc', commands: [{ kind: 'rtc.connect' }] } }] }
                ]
            }
        ]
    };
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: async (input) => {
                observed.push(input);
                throw new Error('Owned Connect input observed; stop before SDK execution.');
            },
            send: refuseUnexercised,
            refreshRoom: refuseUnexercised,
            health: refuseUnexercised,
            close: async () => undefined
        }
    });
    try {
        const pending = runtime.execute({ kind: 'recipe.run', recipe, rtcCaptureMode: 'native' });
        await vi.advanceTimersByTimeAsync(10);
        const execution = await pending;
        expect(execution.ok).toBe(false);
        expect(runtime.state().commandHistory.find((result) => result.kind === 'wait')?.ok).toBe(true);
        expect(runtime.state().commandHistory.find((result) => result.kind === 'rtc.connect')?.error?.message).toBe(
            'Owned Connect input observed; stop before SDK execution.'
        );
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({ rallar: { rtcCaptureMode: undefined, rtcCaptureContext: { run: 'native', recipe: undefined } } });
        const resolution = resolveDistributedRunTargets({
            manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
            agents: [agentWith({ ...BASELINE_ONLY_CAPABILITIES, assertions: { ...BASELINE_ONLY_CAPABILITIES.assertions, absence: true } })],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(resolution.targetAgentIds).toEqual([]);
        expect(resolution.blockers.some((blocker) => blocker.status === 'missing-rtc-capture-capability')).toBe(true);
    }
    finally {
        await runtime.execute({ kind: 'close' });
        vi.useRealTimers();
        vi.unstubAllGlobals();
    }
});

it('refuses a sibling-loaded Native recipe with omitted ambient capture during a wait', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => null });
    const observed: RallarBlackBoxBrowserRallarConnectionConfig[] = [];
    const refuseUnexercised = async (): Promise<never> => {
        throw new Error('Unexercised owned browser method refused.');
    };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'parallel-loaded-native-body',
        commands: [
            { kind: 'recipe.load', recipe: { schemaVersion: 1, recipeId: 'loaded-health', commands: [{ kind: 'health' }] } },
            {
                kind: 'parallel',
                maxConcurrency: 2,
                groups: [
                    {
                        commands: [
                            { kind: 'wait', commandId: 'owned-absence', absent: true, timeoutMs: 10, match: { kind: 'message', topic: 'owned.never' } },
                            { kind: 'recipe.run' }
                        ]
                    },
                    {
                        commands: [{
                            kind: 'recipe.load',
                            recipe: { schemaVersion: 1, recipeId: 'loaded-rtc', rtcCaptureMode: 'native', commands: [{ kind: 'rtc.connect' }] }
                        }]
                    }
                ]
            }
        ]
    };
    const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: async (input) => {
                observed.push(input);
                throw new Error('Owned Connect input observed; stop before SDK execution.');
            },
            send: refuseUnexercised,
            refreshRoom: refuseUnexercised,
            health: refuseUnexercised,
            close: async () => undefined
        }
    });
    try {
        const pending = runtime.execute({ kind: 'recipe.run', recipe });
        await vi.advanceTimersByTimeAsync(10);
        const execution = await pending;
        expect(execution.ok).toBe(false);
        expect(runtime.state().commandHistory.find((result) => result.kind === 'wait')?.ok).toBe(true);
        expect(runtime.state().commandHistory.find((result) => result.kind === 'rtc.connect')?.error?.message).toBe(
            'Owned Connect input observed; stop before SDK execution.'
        );
        expect(observed).toHaveLength(1);
        expect(observed[0]).toMatchObject({ rallar: { rtcCaptureMode: undefined, rtcCaptureContext: { run: undefined, recipe: 'native' } } });
        const resolution = resolveDistributedRunTargets({
            manifest: manifestWith(recipe),
            agents: [agentWith({ ...BASELINE_ONLY_CAPABILITIES, assertions: { ...BASELINE_ONLY_CAPABILITIES.assertions, absence: true } })],
            nowEpochMs: 1_500,
            staleAfterMs: 30_000
        });
        expect(resolution.targetAgentIds).toEqual([]);
        expect(resolution.blockers.some((blocker) => blocker.status === 'missing-rtc-capture-capability')).toBe(true);
    }
    finally {
        await runtime.execute({ kind: 'close' });
        vi.useRealTimers();
        vi.unstubAllGlobals();
    }
});

it.each([
    {
        label: 'distinct known Health references',
        ambient: 'native' as const,
        replacementKind: 'health' as const,
        inline: false,
        concurrency: 2,
        reset: false,
        expected: ['gate-agent']
    },
    {
        label: 'inline Health despite a sibling RTC load',
        ambient: 'native' as const,
        replacementKind: 'rtc.connect' as const,
        inline: true,
        concurrency: 2,
        reset: false,
        expected: ['gate-agent']
    },
    {
        label: 'genuine capture omission',
        ambient: undefined,
        replacementKind: 'rtc.connect' as const,
        inline: false,
        concurrency: 2,
        reset: false,
        expected: ['gate-agent']
    },
    {
        label: 'definite Health reference before serial replacement',
        ambient: 'native' as const,
        replacementKind: 'rtc.connect' as const,
        inline: false,
        concurrency: 1,
        reset: false,
        expected: ['gate-agent']
    },
    {
        label: 'own Health reset after parallel replacement',
        ambient: 'native' as const,
        replacementKind: 'rtc.connect' as const,
        inline: false,
        concurrency: 2,
        reset: true,
        expected: ['gate-agent']
    }
])('parallel loaded reference control: $label', ({ ambient, replacementKind, inline, concurrency, reset, expected }) => {
    const health: RallarBlackBoxTestRecipe = { schemaVersion: 1, recipeId: 'known-health', commands: [{ kind: 'health' }] };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'parallel-reference-control',
        commands: [
            { kind: 'recipe.load', recipe: health },
            {
                kind: 'parallel',
                maxConcurrency: concurrency,
                groups: [
                    { commands: [reset ? { kind: 'health' } : { kind: 'recipe.run', ...(inline ? { recipe: health } : {}) }] },
                    { commands: [{ kind: 'recipe.load', recipe: { schemaVersion: 1, recipeId: 'replacement', commands: [{ kind: replacementKind }] } }] }
                ]
            },
            ...(reset ? [{ kind: 'recipe.load' as const, recipe: health }, { kind: 'recipe.run' as const }] : [])
        ]
    };
    const resolution = resolveDistributedRunTargets({
        manifest: { ...manifestWith(recipe), rtcCaptureMode: ambient },
        agents: [agentWith(undefined)],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual(expected);
});

it.each([
    { label: 'all Health', work: { kind: 'health' as const }, expected: ['gate-agent'] },
    { label: 'RTC before reentry', work: { kind: 'rtc.connect' as const }, expected: [] }
])('terminates finite ambient reference cycle with $label', ({ work, expected }) => {
    const loaded: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'known-cycle',
        commands: [work, { kind: 'recipe.run' }]
    };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'cycle-owner',
        commands: [{ kind: 'recipe.load', recipe: loaded }, { kind: 'recipe.run' }]
    };
    expect(validateExecutableRecipe(recipe)).toEqual([]);
    const resolution = resolveDistributedRunTargets({
        manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
        agents: [agentWith(undefined)],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual(expected);
});

it.each([
    {
        label: 'mode changes before reentry',
        work: { kind: 'rtc.connect' as const },
        initial: { rallar: { rtcCaptureMode: 'off' as const } },
        update: { rallar: { rtcCaptureMode: 'native' as const } },
        ambient: undefined
    },
    {
        label: 'transport changes before reentry',
        work: { kind: 'crdt.open' as const, name: 'recursive-doc' },
        initial: { rallar: { crdtTransport: 'local-only' as const } },
        update: { rallar: { crdtTransport: 'ws' as const } },
        ambient: 'native' as const
    }
])('retains recursive required capture when $label', ({ work, initial, update, ambient }) => {
    const loaded: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'changed-cycle',
        commands: [work, { kind: 'configure', config: update }, { kind: 'recipe.run' }]
    };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'changed-cycle-owner',
        commands: [{ kind: 'configure', config: initial }, { kind: 'recipe.load', recipe: loaded }, { kind: 'recipe.run' }]
    };
    expect(validateExecutableRecipe(recipe)).toEqual([]);
    const resolution = resolveDistributedRunTargets({
        manifest: { ...manifestWith(recipe), rtcCaptureMode: ambient },
        agents: [agentWith({ ...BASELINE_ONLY_CAPABILITIES, rtcCapture: { configurationVersion: 1, modes: ['off'] } })],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual([]);
});

it.each([
    { modes: ['native'] as const, expected: [] },
    { modes: ['off', 'native'] as const, expected: ['gate-agent'] }
])('retains both modes in a recursive nonlocal body with advertised $modes', ({ modes, expected }) => {
    const loaded: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'nonlocal-changing-mode',
        commands: [
            { kind: 'crdt.open', name: 'changing-mode-doc', transport: 'ws' },
            { kind: 'configure', config: { rallar: { rtcCaptureMode: 'native' } } },
            { kind: 'recipe.run' }
        ]
    };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'nonlocal-changing-mode-owner',
        commands: [
            { kind: 'configure', config: { rallar: { rtcCaptureMode: 'off' } } },
            { kind: 'recipe.load', recipe: loaded },
            { kind: 'recipe.run' }
        ]
    };
    const resolution = resolveDistributedRunTargets({
        manifest: manifestWith(recipe),
        agents: [agentWith({ ...BASELINE_ONLY_CAPABILITIES, rtcCapture: { configurationVersion: 1, modes } })],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual(expected);
});

it('discovers a sibling Configure inside a possible loaded Health body before classifying another branch', () => {
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'loaded-config-capture',
        commands: [
            { kind: 'configure', config: { rallar: { crdtTransport: 'local-only' } } },
            { kind: 'recipe.load', recipe: { schemaVersion: 1, recipeId: 'original-health', commands: [{ kind: 'health' }] } },
            {
                kind: 'parallel',
                groups: [
                    { commands: [{ kind: 'crdt.open', name: 'other-branch' }] },
                    { commands: [{ kind: 'recipe.run' }] },
                    {
                        commands: [{
                            kind: 'recipe.load',
                            recipe: {
                                schemaVersion: 1,
                                recipeId: 'configuring-health',
                                commands: [{ kind: 'configure', config: { rallar: { crdtTransport: 'ws' } } }, { kind: 'health' }]
                            }
                        }]
                    }
                ]
            }
        ]
    };
    const resolution = resolveDistributedRunTargets({
        manifest: { ...manifestWith(recipe), rtcCaptureMode: 'native' },
        agents: [agentWith(undefined)],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual([]);
});

it.each([
    { label: 'concurrent final bodies remain possible', concurrency: 2, firstKind: 'rtc.connect' as const, reset: false, expected: [] },
    { label: 'serial final Health body is definite', concurrency: 1, firstKind: 'rtc.connect' as const, reset: false, expected: ['gate-agent'] },
    { label: 'known Health bodies with Native recipe intent', concurrency: 2, firstKind: 'health' as const, reset: false, expected: ['gate-agent'] },
    { label: 'own Health load clears completed ambiguity', concurrency: 2, firstKind: 'rtc.connect' as const, reset: true, expected: ['gate-agent'] }
])('loaded-body lifetime control: $label', ({ concurrency, firstKind, reset, expected }) => {
    const health: RallarBlackBoxTestRecipe = { schemaVersion: 1, recipeId: 'final-health', commands: [{ kind: 'health' }] };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'final-reference-owner',
        commands: [
            {
                kind: 'parallel',
                maxConcurrency: concurrency,
                groups: [
                    {
                        commands: [{
                            kind: 'recipe.load',
                            recipe: { schemaVersion: 1, recipeId: 'first-final', rtcCaptureMode: 'native', commands: [{ kind: firstKind }] }
                        }]
                    },
                    { commands: [{ kind: 'recipe.load', recipe: health }] }
                ]
            },
            ...(reset ? [{ kind: 'recipe.load' as const, recipe: health }] : []),
            { kind: 'recipe.run' }
        ]
    };
    const resolution = resolveDistributedRunTargets({
        manifest: manifestWith(recipe),
        agents: [agentWith(undefined)],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual(expected);
});

it.each([
    { modes: ['off'] as const, expected: [] },
    { modes: ['off', 'native'] as const, expected: ['gate-agent'] }
])('retains changed loaded-body modes with advertised $modes', ({ modes, expected }) => {
    const native: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'native-reference-cycle',
        rtcCaptureMode: 'native',
        commands: [{ kind: 'rtc.connect' }, { kind: 'recipe.run' }]
    };
    const off: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'off-reference-body',
        rtcCaptureMode: 'off',
        commands: [{ kind: 'rtc.connect' }, { kind: 'recipe.load', recipe: native }, { kind: 'recipe.run' }]
    };
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'changed-reference-owner',
        commands: [{ kind: 'recipe.load', recipe: off }, { kind: 'recipe.run' }]
    };
    const resolution = resolveDistributedRunTargets({
        manifest: manifestWith(recipe),
        agents: [agentWith({ ...BASELINE_ONLY_CAPABILITIES, rtcCapture: { configurationVersion: 1, modes } })],
        nowEpochMs: 1_500,
        staleAfterMs: 30_000
    });
    expect(resolution.targetAgentIds).toEqual(expected);
});
