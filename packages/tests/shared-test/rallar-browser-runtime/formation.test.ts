import { BlackBoxRallarRuntimeDiagnostics } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-diagnostics.ts';
import type {
    BlackBoxRallarEvent,
    BlackBoxRallarFormationSummary
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntimeInstallationTarget } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import { decodeBlackBoxRallarFormationCommandInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/formation/decode-black-box-rallar-formation-input.ts';
import { BlackBoxRallarFormationController } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/formation/formation-controller.ts';
import { installSpaBrowserRallarEventBridge } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import { toControlEventEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import type { RallarRoomTransportStatus, RallarRtcRoomTransportStatus, RallarRtcStatusListener } from '@shared-web/browser/rallar-rtc-facade.ts';
import type {
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type {
    RallarRoomConnectOptions,
    RallarRoomFormation,
    RallarRoomFormationCommandOptions,
    RallarRoomFormationStatus,
    RallarRoomLayoutEvent,
    RallarRoomLayoutListener,
    RallarRoomReconfigureOptions
} from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { controlEventArtifactJsonl } from '../../../../apps/rallar-black-box-control-server/src/control-artifacts.ts';
import { toLiveRtcLifecycleHistory } from '../../../../tests/playwright/rallar-black-box/live-rtc-agent-diagnostics.ts';
import { createAcceptedOverlayFixture, createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';
import {
    facade,
    loadRuntime,
    resetFacade
} from './browser-rallar-runtime-test-harness.ts';

const PLANNED: GroupLayoutIdentity = {
    groupRevision: 4,
    presenceRevision: 5,
    version: 2,
    state: 'active'
};

it.each([
    { value: { command: 'plan' }, expected: { command: 'plan' } },
    { value: { command: 'connect' }, expected: { command: 'connect' } },
    {
        value: { command: 'connect', layout: PLANNED },
        expected: { command: 'connect', layout: PLANNED }
    },
    { value: { command: 'reconfigure' }, expected: { command: 'reconfigure' } },
    {
        value: { command: 'reconfigure', landing: 'hold' },
        expected: { command: 'reconfigure', landing: 'hold' }
    }
])('decodes $value.command', ({ value, expected }) => {
    expect(decodeBlackBoxRallarFormationCommandInput(value).right).toEqual(
        expected
    );
});

// The eight the shipped handle exposes; a ninth name is not a formation command.
it.each([
    'plan',
    'connect',
    'activate',
    'reconfigure',
    'pause',
    'resume',
    'reset',
    'start'
])('accepts the %s command', (command) => {
    expect(
        decodeBlackBoxRallarFormationCommandInput({ command }).left
    ).toBeUndefined();
});

it.each([
    { command: 'explode' },
    { command: 'plan', landing: 'hold' },
    { command: 'plan', layout: PLANNED },
    { command: 'reconfigure', layout: PLANNED },
    { command: 'connect', landing: 'hold' },
    { command: 'connect', layout: { groupRevision: 1 } },
    { command: 'reconfigure', landing: 'sideways' },
    { command: 'plan', unexpected: true },
    'plan',
    null
])('refuses %o', (value) => {
    const issues = decodeBlackBoxRallarFormationCommandInput(value).left;

    expect(issues?.length).toBeGreaterThan(0);
});

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

/** Every option object the eight handle methods accept; the fake records what it was given. */
type FormationCommandOptions =
    | RallarRoomFormationCommandOptions
    | RallarRoomConnectOptions
    | RallarRoomReconfigureOptions
    | undefined;

namespace FormationHarness {
    export interface Input {
        readonly stage: GroupLifecycleState;
        readonly formationEpoch: number;
        readonly desiredPeerIds?: readonly string[];
        readonly readyPeerIds?: readonly string[];
        readonly state?: RallarRtcRoomTransportStatus['state'];
    }
}

class FormationHarness {
    readonly snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['session-a'] });
    readonly calls: (readonly [string, FormationCommandOptions])[] = [];
    readonly emitted: Omit<BlackBoxRallarEvent, 'atEpochMs'>[] = [];
    readonly #changeListeners: RallarStateListener<RallarRoomFormationStatus>[] = [];
    readonly #layoutListeners: RallarRoomLayoutListener[] = [];
    readonly #statusListeners: RallarRtcStatusListener[] = [];
    readonly formation: RallarRoomFormation;
    readonly controller: BlackBoxRallarFormationController;
    #status: RallarRoomFormationStatus | undefined;
    #room: RallarRtcRoomTransportStatus;

    constructor(input: FormationHarness.Input) {
        this.#status = toFormationStatus(input, this.snapshot);
        this.#room = toRoomStatus(input);
        this.formation = this.#createFormation();
        this.controller = new BlackBoxRallarFormationController({
            formation: () => this.formation,
            rtc: {
                roomStatus: this.roomStatus,
                waitForRoom: this.waitForRoom,
                onStatus: (listener) => subscribe(this.#statusListeners, listener)
            },
            emit: this.emit,
            now: () => 1_000
        });
    }

    readonly emit = vi.fn((event: Omit<BlackBoxRallarEvent, 'atEpochMs'>): void => {
        this.emitted.push(event);
    });

    readonly roomStatus = (): RallarRoomTransportStatus => ({
        roomRef,
        ws: {
            connectState: 'connected',
            readyState: 'open',
            isOpen: true,
            reconnecting: false,
            reconnectEnabled: true,
            reconnectAttempts: 0,
            maxReconnectAttempts: 5,
            reconnectExhausted: false
        },
        rtc: this.#room
    });

    readonly waitForRoom = vi.fn(async () => this.roomStatus());

    releaseRoom(): void {
        this.#status = undefined;
    }

    emitChange(next: Partial<RallarRoomFormationStatus>): void {
        if (!this.#status) {
            throw new Error('Expected a held room.');
        }
        this.#status = { ...this.#status, ...next };
        for (const listener of [...this.#changeListeners]) {
            listener(this.#status);
        }
    }

    emitLayout(event: RallarRoomLayoutEvent): void {
        for (const listener of [...this.#layoutListeners]) {
            listener(event);
        }
    }

    updateRoomAndNotify(next: Partial<RallarRtcRoomTransportStatus>): void {
        this.#room = { ...this.#room, ...next };
        for (const listener of [...this.#statusListeners]) {
            listener({
                laneId: this.#room.laneId,
                knownPeerIds: this.#room.knownPeerIds,
                activePeerIds: this.#room.activePeerIds,
                readyPeerIds: this.#room.readyPeerIds,
                peerIdsWithNoReconnectableLanes: [],
                peers: this.#room.peers
            });
        }
    }

    #record = (name: string) => (options?: FormationCommandOptions): Promise<GroupSnapshot> => {
        this.calls.push([name, options]);
        return Promise.resolve(this.snapshot);
    };

    #createFormation(): RallarRoomFormation {
        return {
            roomRef,
            status: () => this.#status,
            readView: () => Promise.reject(new Error('unused')),
            plan: this.#record('plan'),
            connect: this.#record('connect'),
            activate: this.#record('activate'),
            reconfigure: this.#record('reconfigure'),
            pause: this.#record('pause'),
            resume: this.#record('resume'),
            reset: this.#record('reset'),
            start: this.#record('start'),
            waitForStage: () => Promise.reject(new Error('unused')),
            waitForCondition: () => Promise.reject(new Error('unused')),
            waitForLayout: () => Promise.reject(new Error('unused')),
            onChange: (listener) => subscribe(this.#changeListeners, listener),
            onLayout: (listener) => subscribe(this.#layoutListeners, listener)
        };
    }
}

function toFormationStatus(input: FormationHarness.Input, snapshot: GroupSnapshot): RallarRoomFormationStatus {
    return {
        roomRef,
        stage: input.stage,
        formationEpoch: input.formationEpoch,
        formationAttemptCount: 0,
        lastFormationOutcome: undefined,
        transportState: 'flowing',
        dialing: 'none',
        memberPolicy: { maxConcurrentEdgeSetups: 4, transports: 'rtc-and-ws' },
        accepted: undefined,
        planned: undefined,
        condition: undefined,
        coverageRate: undefined,
        snapshot
    };
}

function toRoomStatus(input: FormationHarness.Input): RallarRtcRoomTransportStatus {
    return {
        desired: true,
        mode: 'eager',
        state: input.state ?? 'idle',
        desiredPeerIds: input.desiredPeerIds ?? [],
        knownPeerIds: [],
        activePeerIds: [],
        readyPeerIds: input.readyPeerIds ?? [],
        failedPeerIds: [],
        peers: [],
        laneId: 'lane-1',
        lastChangedAtEpochMs: 1,
        reason: 'private-unknown-reason'
    };
}

function subscribe<T>(listeners: T[], listener: T): RallarUnsubscribe {
    listeners.push(listener);
    return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
            listeners.splice(index, 1);
        }
    };
}

it('issues the command and reports the receipt beside the summary', async () => {
    const harness = new FormationHarness({
        stage: 'planned',
        formationEpoch: 1
    });

    const diagnostics = await harness.controller.command({
        roomRef,
        timeoutMs: 5_000,
        input: { command: 'plan' }
    });

    expect(harness.calls).toEqual([['plan', {}]]);
    expect(diagnostics.formation).toMatchObject({
        stage: 'planned',
        formationEpoch: 1,
        dialing: 'none'
    });
    expect(diagnostics.receipt.causalRevision).toEqual(
        diagnostics.formation.causalRevision
    );
});

it('omits the absent fields from the summary instead of carrying undefined keys', async () => {
    const harness = new FormationHarness({
        stage: 'planned',
        formationEpoch: 1
    });

    const { formation: summary } = await harness.controller.command({
        roomRef,
        timeoutMs: 5_000,
        input: { command: 'plan' }
    });

    expect(Object.keys(summary)).not.toContain('accepted');
    expect(Object.keys(summary)).not.toContain('coverageRate');
    expect(
        JSON.parse(JSON.stringify(summary)) as BlackBoxRallarFormationSummary
    ).toEqual(summary);
});

it('passes the named layout to connect and the landing to reconfigure', async () => {
    const harness = new FormationHarness({
        stage: 'planned',
        formationEpoch: 1
    });

    await harness.controller.command({
        roomRef,
        timeoutMs: 5_000,
        input: { command: 'connect', layout: PLANNED },
        reason: 'fence'
    });
    await harness.controller.command({
        roomRef,
        timeoutMs: 5_000,
        input: { command: 'reconfigure', landing: 'hold' }
    });

    expect(harness.calls).toEqual([
        ['connect', { reason: 'fence', layout: PLANNED }],
        ['reconfigure', { landing: 'hold' }]
    ]);
});

it('delegates observation-only readiness to the canonical room wait and emits the ready diagnostic', async () => {
    const harness = new FormationHarness({
        stage: 'active',
        formationEpoch: 3,
        desiredPeerIds: ['b', 'c'],
        readyPeerIds: ['b', 'c'],
        state: 'open'
    });
    const result = await harness.controller.readiness({
        roomRef,
        timeoutMs: 5_000
    });

    expect(result.formation.room.readyPeerIds).toEqual(['b', 'c']);
    expect(harness.waitForRoom).toHaveBeenCalledWith(roomRef, {
        connect: false,
        timeoutMs: 5_000
    });
    expect(harness.emitted.map((event) => event.topic)).toEqual(['rallar.browser.formation.ready']);
});

it('returns the room status captured by the canonical wait when the live view changes afterward', async () => {
    const harness = new FormationHarness({
        stage: 'active',
        formationEpoch: 3,
        desiredPeerIds: ['b'],
        readyPeerIds: ['b'],
        state: 'open'
    });
    const readyRoom = harness.controller.summary(roomRef)?.room;
    if (!readyRoom) {
        throw new Error('Expected the fixture to expose its ready room.');
    }
    harness.waitForRoom.mockImplementationOnce(async () => {
        harness.updateRoomAndNotify({
            state: 'idle',
            desiredPeerIds: [],
            readyPeerIds: []
        });
        return {
            roomRef,
            ws: harness.roomStatus().ws,
            rtc: {
                desired: true,
                mode: 'eager',
                ...readyRoom,
                knownPeerIds: [],
                peers: [],
                laneId: 'lane-1',
                lastChangedAtEpochMs: 1,
                reason: 'fixture'
            }
        };
    });

    await expect(
        harness.controller.readiness({ roomRef, timeoutMs: 5_000 })
    ).resolves.toMatchObject({
        formation: {
            room: {
                state: 'open',
                desiredPeerIds: ['b'],
                readyPeerIds: ['b']
            }
        }
    });
});

it('rejects an edgeless room returned by the canonical readiness owner', async () => {
    const harness = new FormationHarness({
        stage: 'active',
        formationEpoch: 3,
        state: 'open'
    });

    await expect(
        harness.controller.readiness({ roomRef, timeoutMs: 50 })
    ).rejects.toThrow('RALLAR_BLACK_BOX_FORMATION_NOT_READY');
    expect(harness.waitForRoom).toHaveBeenCalledWith(roomRef, {
        connect: false,
        timeoutMs: 50
    });
    expect(harness.emitted).not.toContainEqual(
        expect.objectContaining({ topic: 'rallar.browser.formation.ready' })
    );
});

it('retains the rejected captured room result when the later live view is open', async () => {
    const harness = new FormationHarness({ stage: 'active', formationEpoch: 3, state: 'idle', desiredPeerIds: ['b'] });
    const captured = await harness.waitForRoom();
    harness.waitForRoom.mockImplementationOnce(async () => {
        harness.updateRoomAndNotify({ state: 'open', desiredPeerIds: ['b'], readyPeerIds: ['b'] });
        return captured;
    });
    await expect(harness.controller.readiness({ roomRef, timeoutMs: 50 })).rejects.toThrow('state open');
    expect(harness.emitted).toContainEqual(expect.objectContaining({
        topic: 'rallar.browser.formation.not-ready',
        data: {
            kind: 'formation-readiness-rejected',
            roomTransportState: 'idle',
            summaryAvailable: true,
            roomOpen: false,
            hasDesiredPeers: true,
            desiredPeerCount: 1,
            readyPeerCount: 0,
            waitTerminalCause: 'unknown'
        }
    }));
});

it('forwards changes, layout events and room status as diagnostics', () => {
    const harness = new FormationHarness({
        stage: 'planned',
        formationEpoch: 1
    });
    const unsubscribe = harness.controller.installDiagnostics(roomRef);

    harness.emitChange({ stage: 'connecting' });
    harness.emitLayout({
        kind: 'layoutAccepted',
        roomRef,
        layout: { role: 'accepted', identity: PLANNED, overlay: createAcceptedOverlayFixture(harness.snapshot, 2, []) }
    });
    harness.updateRoomAndNotify({ readyPeerIds: ['b'] });
    unsubscribe();
    harness.emitChange({ stage: 'active' });
    harness.updateRoomAndNotify({ readyPeerIds: [] });

    expect(harness.emitted.map((event) => event.topic)).toEqual([
        'rallar.browser.formation.changed',
        'rallar.browser.formation.layout',
        'rallar.browser.formation.room-status'
    ]);
});

beforeEach(() => {
    resetFacade();
});

afterEach(() => {
    vi.unstubAllGlobals();
    resetFacade();
});

it('installs the formation diagnostics for a room-scoped connection and tears them down on close', async () => {
    const runtime = await loadRuntime();
    const active = new Set<string>();
    const held = facade.rallar.rooms.formation(roomRef);
    facade.behavior.roomFormation.mockReturnValue({
        ...held,
        onChange: () => {
            active.add('change');
            return () => {
                active.delete('change');
            };
        },
        onLayout: () => {
            active.add('layout');
            return () => {
                active.delete('layout');
            };
        }
    });
    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        }
    });

    expect(active).toEqual(new Set(['change', 'layout']));
    await runtime.close();
    expect([...active]).toEqual([]);
});

it('removes the formation diagnostics when the connection fails after installing them', async () => {
    const runtime = await loadRuntime();
    const activeSubscriptions = new Set<string>();
    const track = (name: string): RallarUnsubscribe => {
        activeSubscriptions.add(name);
        return () => {
            activeSubscriptions.delete(name);
        };
    };
    const idleFormation = facade.rallar.rooms.formation(roomRef);
    facade.behavior.roomFormation.mockReturnValue({
        ...idleFormation,
        onChange: () => track('formation.change'),
        onLayout: () => track('formation.layout')
    });
    facade.behavior.rtcOnStatus.mockImplementation(() => track('rtc.status'));
    facade.behavior.roomJoin.mockImplementation(async () => {
        expect(activeSubscriptions).toEqual(new Set(['formation.change', 'formation.layout', 'rtc.status']));
        throw new Error('Room join failed.');
    });

    await expect(runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret',
            applicationId: 'app-1',
            workspaceId: 'workspace-1'
        }
    })).rejects.toThrow('Room join failed.');

    expect([...activeSubscriptions]).toEqual([]);
});

it('installs no formation diagnostics when the connection resolves no room ref', async () => {
    const runtime = await loadRuntime();
    const changeListeners: RallarStateListener<RallarRoomFormationStatus>[] = [];
    const layoutListeners: RallarRoomLayoutListener[] = [];
    const statusListeners: RallarRtcStatusListener[] = [];
    const held = facade.rallar.rooms.formation(roomRef);
    facade.behavior.roomFormation.mockReturnValue({
        ...held,
        onChange: (listener) => subscribe(changeListeners, listener),
        onLayout: (listener) => subscribe(layoutListeners, listener)
    });
    facade.behavior.rtcOnStatus.mockImplementation((listener) => subscribe(statusListeners, listener));
    await runtime.connect({
        connection: 'aliceRtc',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            username: 'alice',
            password: 'secret'
        }
    });

    expect({ changeListeners, layoutListeners, statusListeners }).toEqual({
        changeListeners: [],
        layoutListeners: [],
        statusListeners: []
    });
    await runtime.close();
    expect({ changeListeners, layoutListeners, statusListeners }).toEqual({
        changeListeners: [],
        layoutListeners: [],
        statusListeners: []
    });
});

it.each(
    [
        { state: 'idle', peers: ['b'], held: true, open: false, desired: true },
        { state: 'open', peers: [], held: true, open: true, desired: false },
        { state: 'open', peers: ['b'], held: false, open: true, desired: true }
    ] as const
)('retains rejection predicates for $state, held=$held, desired=$desired', async ({ state, peers, held, open, desired }) => {
    const harness = new FormationHarness({ stage: 'active', formationEpoch: 1, state, desiredPeerIds: peers });
    if (!held) {
        harness.releaseRoom();
    }
    await expect(harness.controller.readiness({ roomRef, timeoutMs: 50 })).rejects.toThrow('RALLAR_BLACK_BOX_FORMATION_NOT_READY');
    expect(harness.emitted).toMatchObject([{
        data: {
            roomTransportState: state,
            summaryAvailable: held,
            roomOpen: open,
            hasDesiredPeers: desired,
            desiredPeerCount: peers.length,
            readyPeerCount: 0,
            waitTerminalCause: 'unknown'
        }
    }]);
    expect(JSON.stringify(harness.emitted)).not.toContain('private-unknown-reason');
});

it('keeps the formation rejection when the supplemental sink throws and does not observe a rejected wait promise as a returned result', async () => {
    const harness = new FormationHarness({ stage: 'active', formationEpoch: 1 });
    harness.emit.mockImplementationOnce((event) => {
        harness.emitted.push(event);
        throw new Error('supplemental sink failed');
    });
    await expect(harness.controller.readiness({ roomRef, timeoutMs: 50 })).rejects.toThrow(
        'RALLAR_BLACK_BOX_FORMATION_NOT_READY: the room did not open within 50 ms (state idle).'
    );
    expect(harness.emitted.map((event) => event.topic)).toEqual(['rallar.browser.formation.not-ready']);
    harness.emitted.length = 0;
    const waitFailure = new Error('wait rejected without a returned result');
    harness.waitForRoom.mockRejectedValueOnce(waitFailure);
    await expect(harness.controller.readiness({ roomRef, timeoutMs: 50 })).rejects.toBe(waitFailure);
    expect(harness.emitted).toEqual([]);
});

it('carries the actual formation observation through diagnostics, browser receipt, recorder serialization and bounded projection', async () => {
    const runtime = createRallarBlackBoxBrowserTestRuntime({ now: () => 120 });
    const target: BlackBoxRallarRuntimeInstallationTarget = {};
    vi.stubGlobal('window', target);
    const cleanup = installSpaBrowserRallarEventBridge(runtime);
    const diagnostics = new BlackBoxRallarRuntimeDiagnostics({
        now: () => 119,
        publish: (event) => target.__blackBoxRallarEmit?.(event),
        onPublishError: (error) => {
            throw error;
        },
        transportOf: () => 'realtime',
        laneIdOf: () => 'realtime',
        scopeDiagnostics: () => ({})
    });
    const harness = new FormationHarness({ stage: 'active', formationEpoch: 1, desiredPeerIds: ['b'] });
    harness.emit.mockImplementation(diagnostics.emit);
    await expect(harness.controller.readiness({ roomRef, timeoutMs: 50 })).rejects.toThrow('RALLAR_BLACK_BOX_FORMATION_NOT_READY');
    const event = runtime.state().events.find((event) => event.topic === 'rallar.browser.formation.not-ready');
    if (!event) {
        throw new Error('Expected actual formation diagnostic in runtime history.');
    }
    const jsonl = controlEventArtifactJsonl(toControlEventEnvelope(event, 'run', 'agent-a'));
    const history = toLiveRtcLifecycleHistory({
        jsonl,
        bytesRead: Buffer.byteLength(jsonl),
        retainedBytes: Buffer.byteLength(jsonl),
        retainedPrefixDropped: false,
        transportTruncated: false,
        agentIds: ['agent-a'],
        cycle: null,
        failureInterval: { caseId: 'all-scenarios', startedAtEpochMs: 100, failedAtEpochMs: 150, precision: 'attempt-phase-unspecified' }
    });
    expect(history['agent-a']).toMatchObject({
        events: [{
            kind: 'formation-readiness-rejected',
            runtimeAtEpochMs: 119,
            controlAtEpochMs: 120,
            roomTransportState: 'idle',
            summaryAvailable: true,
            roomOpen: false,
            hasDesiredPeers: true,
            desiredPeerCount: 1,
            readyPeerCount: 0,
            waitTerminalCause: 'unknown'
        }]
    });
    expect(JSON.stringify(history)).not.toContain('private-unknown-reason');
    cleanup();
    expect(target.__blackBoxRallarEmit).toBeUndefined();
});
