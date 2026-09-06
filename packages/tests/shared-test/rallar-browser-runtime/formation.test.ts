import type {
    BlackBoxRallarEvent,
    BlackBoxRallarFormationSummary
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import { decodeBlackBoxRallarFormationCommandInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-formation-input.ts';
import { BlackBoxRallarFormationController } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/formation-controller.ts';
import type { RallarRtcRoomTransportStatus } from '@shared-web/browser/rallar-rtc-facade.ts';
import type { RallarStateListener, RallarUnsubscribe } from '@shared-web/browser/rallar-shared-contracts.ts';
import type {
    RallarRoomFormation,
    RallarRoomFormationStatus,
    RallarRoomLayoutEvent,
    RallarRoomLayoutListener
} from '@shared-web/browser/rooms/formation/rallar-room-formation-contracts.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupLifecycleState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { expect, it } from 'vitest';

import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';

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
    expect(decodeBlackBoxRallarFormationCommandInput(value).right).toEqual(expected);
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
    expect(decodeBlackBoxRallarFormationCommandInput({ command }).left).toBeUndefined();
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

interface HarnessInput {
    readonly stage: GroupLifecycleState;
    readonly formationEpoch: number;
    readonly desiredPeerIds?: readonly string[];
    readonly readyPeerIds?: readonly string[];
    readonly state?: RallarRtcRoomTransportStatus['state'];
}

function createFormationHarness(input: HarnessInput) {
    const snapshot: GroupSnapshot = createGroupSnapshotFixture({
        applicationId: roomRef.applicationId,
        workspaceId: roomRef.workspaceId,
        groupId: roomRef.groupId,
        sessionIds: ['session-a']
    });
    const calls: (readonly [string, unknown])[] = [];
    const changeListeners: RallarStateListener<RallarRoomFormationStatus>[] = [];
    const layoutListeners: RallarRoomLayoutListener[] = [];
    const statusListeners: (() => void)[] = [];
    const emitted: Omit<BlackBoxRallarEvent, 'atEpochMs'>[] = [];

    let status: RallarRoomFormationStatus = {
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
    let room: RallarRtcRoomTransportStatus = {
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
        reason: 'fixture'
    };

    const record = (name: string) => (options?: unknown): Promise<GroupSnapshot> => {
        calls.push([name, options]);
        return Promise.resolve(snapshot);
    };
    const subscribe = <T>(listeners: T[], listener: T): RallarUnsubscribe => {
        listeners.push(listener);
        return () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) {
                listeners.splice(index, 1);
            }
        };
    };

    const formation = {
        roomRef,
        status: () => status,
        readView: () => Promise.reject(new Error('unused')),
        plan: record('plan'),
        connect: record('connect'),
        activate: record('activate'),
        reconfigure: record('reconfigure'),
        pause: record('pause'),
        resume: record('resume'),
        reset: record('reset'),
        start: record('start'),
        waitForStage: () => Promise.reject(new Error('unused')),
        waitForCondition: () => Promise.reject(new Error('unused')),
        waitForLayout: () => Promise.reject(new Error('unused')),
        onChange: (listener: RallarStateListener<RallarRoomFormationStatus>) => subscribe(changeListeners, listener),
        onLayout: (listener: RallarRoomLayoutListener) => subscribe(layoutListeners, listener)
    } as unknown as RallarRoomFormation;

    const controller = new BlackBoxRallarFormationController({
        formation: () => formation,
        rtc: {
            roomStatus: () => ({ roomRef, ws: { connected: true } as never, rtc: room }),
            onStatus: (listener: (status: never) => void) => subscribe(statusListeners, () => listener({} as never))
        } as never,
        emit: (event) => {
            emitted.push(event);
        },
        emitError: () => {},
        now: () => 1_000
    });

    return {
        controller,
        calls,
        emitted,
        formation,
        emitChange(next: Partial<RallarRoomFormationStatus>) {
            status = { ...status, ...next };
            for (const listener of [...changeListeners]) {
                listener(status);
            }
        },
        emitLayout(event: RallarRoomLayoutEvent) {
            for (const listener of [...layoutListeners]) {
                listener(event);
            }
        },
        setRoom(next: Partial<RallarRtcRoomTransportStatus>) {
            room = { ...room, ...next };
            for (const listener of [...statusListeners]) {
                listener();
            }
        },
        setRoomWithoutNotifying(next: Partial<RallarRtcRoomTransportStatus>) {
            room = { ...room, ...next };
        }
    };
}

it('issues the command and reports the receipt beside the summary', async () => {
    const harness = createFormationHarness({ stage: 'planned', formationEpoch: 1 });

    const diagnostics = await harness.controller.command({
        roomRef,
        timeoutMs: 5_000,
        input: { command: 'plan' }
    });

    expect(harness.calls).toEqual([['plan', {}]]);
    expect(diagnostics.formation).toMatchObject({ stage: 'planned', formationEpoch: 1, dialing: 'none' });
    expect(diagnostics.receipt.causalRevision).toEqual(diagnostics.formation.causalRevision);
});

it('omits the absent fields from the summary instead of carrying undefined keys', async () => {
    const harness = createFormationHarness({ stage: 'planned', formationEpoch: 1 });

    const { formation: summary } = await harness.controller.command({
        roomRef,
        timeoutMs: 5_000,
        input: { command: 'plan' }
    });

    expect(Object.keys(summary)).not.toContain('accepted');
    expect(Object.keys(summary)).not.toContain('coverageRate');
    expect(JSON.parse(JSON.stringify(summary)) as BlackBoxRallarFormationSummary).toEqual(summary);
});

it('passes the named layout to connect and the landing to reconfigure', async () => {
    const harness = createFormationHarness({ stage: 'planned', formationEpoch: 1 });

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

it('captures the summary in the tick the room readiness resolves and emits the ready diagnostic', async () => {
    const harness = createFormationHarness({
        stage: 'active',
        formationEpoch: 3,
        desiredPeerIds: ['b', 'c']
    });
    const readiness = harness.controller.readiness({ roomRef, timeoutMs: 5_000 });
    harness.setRoom({ state: 'open', readyPeerIds: ['b', 'c'] });

    const result = await readiness;

    expect(result.formation.room.readyPeerIds).toEqual(['b', 'c']);
    expect(harness.emitted.map((event) => event.topic)).toContain('rallar.browser.formation.ready');
});

// R1: `open` is also returned for a layout with no desired peers, so the barrier would resolve on
// its first tick for a reopened member that has not hydrated yet. The non-empty desired set is
// what makes it a fence rather than a coincidence.
it('does not treat an open room with no desired peers as ready', async () => {
    const harness = createFormationHarness({
        stage: 'active',
        formationEpoch: 3,
        state: 'open'
    });
    let settled = false;
    const readiness = harness.controller.readiness({ roomRef, timeoutMs: 50 }).then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        }
    );

    expect(settled).toBe(false);

    harness.setRoom({ desiredPeerIds: ['b'], readyPeerIds: ['b'] });
    await readiness;

    expect(harness.emitted.filter((event) => event.topic === 'rallar.browser.formation.ready')).toHaveLength(1);
});

// R2: the RTC status stream never fires on the arrival of the accepted layout, so a barrier that
// woke only on it would sleep through the transition it exists to observe.
it('wakes on a formation change as well as a room status change', async () => {
    const harness = createFormationHarness({
        stage: 'connecting',
        formationEpoch: 2,
        desiredPeerIds: ['b'],
        readyPeerIds: ['b']
    });
    const readiness = harness.controller.readiness({ roomRef, timeoutMs: 5_000 });

    harness.setRoomWithoutNotifying({ state: 'open' });
    harness.emitChange({ stage: 'active' });

    await expect(readiness).resolves.toMatchObject({ formation: { stage: 'active' } });
});

it('forwards changes, layout events and room status as diagnostics', () => {
    const harness = createFormationHarness({ stage: 'planned', formationEpoch: 1 });
    const unsubscribe = harness.controller.installDiagnostics(roomRef);

    harness.emitChange({ stage: 'connecting' });
    harness.emitLayout({
        kind: 'layoutAccepted',
        roomRef,
        layout: { role: 'accepted', identity: PLANNED, overlay: {} as never }
    });
    harness.setRoom({ readyPeerIds: ['b'] });
    unsubscribe();

    expect(harness.emitted.map((event) => event.topic)).toEqual([
        'rallar.browser.formation.changed',
        'rallar.browser.formation.layout',
        'rallar.browser.formation.room-status'
    ]);
});
