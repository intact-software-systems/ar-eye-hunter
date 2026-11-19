import { expect, it } from 'vitest';

import { FormationHeldReshapeReading } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/formation/formation-held-reshape-reading.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { HeldTopologyReshape } from '@shared/api/topology-plan/topology-reshape-gate.ts';

import { createFormationView } from '../../shared-web/rooms/formation/room-formation-test-fixtures.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const OTHER_ROOM: GroupRef = { ...ROOM, groupId: 'room-2' };
const HELD: HeldTopologyReshape = { wantedReasons: ['leader-rooting'], opensAtEpochMs: 80_000 };

class ReadingFixture {
    nowEpochMs = 20_000;
    served: HeldTopologyReshape | null | Error = null;
    readonly reads: (readonly [string, number, number])[] = [];
    readonly reading = new FormationHeldReshapeReading({
        readView: (roomRef, timeoutMs) => this.readView(roomRef, timeoutMs),
        now: () => this.nowEpochMs
    });

    observeAt(nowEpochMs: number, settled = true, roomRef = ROOM) {
        this.nowEpochMs = nowEpochMs;
        return this.reading.observe({ roomRef, settled, timeoutMs: 5_000 });
    }

    private readView(roomRef: GroupRef, timeoutMs: number): Promise<GroupFormationView> {
        this.reads.push([roomRef.groupId, timeoutMs, this.nowEpochMs]);
        return this.served instanceof Error
            ? Promise.reject(this.served)
            : Promise.resolve(createFormationView(roomRef, { lifecycleState: 'active', heldReshape: this.served }));
    }
}

it('does not read the view while the layout is not settled', async () => {
    const fixture = new ReadingFixture();

    expect(await fixture.observeAt(20_000, false)).toEqual({ reading: 'not-read', because: 'layout-not-settled' });
    expect(fixture.reads).toEqual([]);
});

it('reads the view once the layout is settled and states that nothing is held', async () => {
    const fixture = new ReadingFixture();

    expect(await fixture.observeAt(20_000)).toEqual({ reading: 'none', readAtEpochMs: 20_000 });
    expect(fixture.reads).toEqual([['room-1', 5_000, 20_000]]);
});

it('repeats a held reading without a read until its gate opens, then reads again', async () => {
    const fixture = new ReadingFixture();
    fixture.served = HELD;
    const held = { reading: 'held', readAtEpochMs: 20_000, wantedReasons: ['leader-rooting'], opensAtEpochMs: 80_000 };

    expect(await fixture.observeAt(20_000)).toEqual(held);
    expect(await fixture.observeAt(20_500)).toEqual(held);
    expect(await fixture.observeAt(79_999)).toEqual(held);
    fixture.served = null;
    expect(await fixture.observeAt(80_000)).toEqual({ reading: 'none', readAtEpochMs: 80_000 });
    expect(fixture.reads.map(([, , at]) => at)).toEqual([20_000, 80_000]);
});

it('reads at every settled observation while an open gate still owes its reshape', async () => {
    const fixture = new ReadingFixture();
    fixture.served = { wantedReasons: ['kind-change'], opensAtEpochMs: 10_000 };

    expect(await fixture.observeAt(20_000)).toMatchObject({ reading: 'held', readAtEpochMs: 20_000, opensAtEpochMs: 10_000 });
    expect(await fixture.observeAt(20_500)).toMatchObject({ reading: 'held', readAtEpochMs: 20_500 });
    expect(fixture.reads.map(([, , at]) => at)).toEqual([20_000, 20_500]);
});

it('forgets a held reading when the layout becomes unsettled', async () => {
    const fixture = new ReadingFixture();
    fixture.served = HELD;

    await fixture.observeAt(20_000);
    expect(await fixture.observeAt(21_000, false)).toEqual({ reading: 'not-read', because: 'layout-not-settled' });
    expect(await fixture.observeAt(25_000)).toMatchObject({ reading: 'held', readAtEpochMs: 25_000 });
    expect(fixture.reads.map(([, , at]) => at)).toEqual([20_000, 25_000]);
});

it('reports a failed read as not read and reads again at the next observation', async () => {
    const fixture = new ReadingFixture();
    fixture.served = new Error('Formation view read timed out');

    expect(await fixture.observeAt(20_000))
        .toEqual({ reading: 'not-read', because: 'view-read-failed', message: 'Formation view read timed out' });
    fixture.served = null;
    expect(await fixture.observeAt(20_500)).toEqual({ reading: 'none', readAtEpochMs: 20_500 });
});

it('keeps one reading for each room', async () => {
    const fixture = new ReadingFixture();
    fixture.served = HELD;
    await fixture.observeAt(20_000);
    fixture.served = null;

    expect(await fixture.observeAt(20_500, true, OTHER_ROOM)).toEqual({ reading: 'none', readAtEpochMs: 20_500 });
    expect(await fixture.observeAt(21_000)).toMatchObject({ reading: 'held', readAtEpochMs: 20_000 });
    expect(fixture.reads.map(([room]) => room)).toEqual(['room-1', 'room-2']);
});
