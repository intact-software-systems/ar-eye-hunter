import {
    describe,
    expect,
    it
} from 'vitest';

import { computeAssertCommandOutcome } from '@shared-test/rallar-bb-test/assert/compute-assert-command-outcome.ts';
import type { AlmConformanceStepInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toAlmCellSettle } from '@shared-test/rallar-bb-test/conformance/alm/cell/to-alm-cell-settle.ts';
import { toLoopChildCommand } from '@shared-test/rallar-bb-test/loop/to-loop-child-command.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestLoopCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import type { GroupActivationStatus } from '@shared/api/group-lifecycle/activation-status/group-activation-status.ts';
import type { GroupFormationView } from '@shared/api/group-lifecycle/group-formation-view.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

import { createFormationSnapshot, createFormationView } from '../shared-web/rooms/formation/room-formation-test-fixtures.ts';
import { toConformanceInput } from './alm-conformance-test-input.ts';

const receiver: AlmConformanceStepInput = {
    input: toConformanceInput('rtc'),
    scenarioId: 'delivery-baseline',
    scenarioKey: 'delivery-baseline',
    role: 'receiver',
    roles: ['sender', 'receiver'],
    messageSelector: undefined,
    connect: undefined
};

const GROUP_PATH = `/api/state/apps/${receiver.input.group.applicationId}/workspaces/${receiver.input.group.workspaceId}` +
    `/groups/${receiver.input.group.groupId}`;
const HEAD = { groupRevision: 7, presenceRevision: 4 };
const ACCEPTED: GroupLayoutIdentity = { groupRevision: 6, presenceRevision: 3, version: 2, state: 'active' };
const STATUS: GroupActivationStatus = {
    condition: 'active',
    coverageRate: 1,
    coverageBasisLayoutIdentity: ACCEPTED,
    formationEpoch: 2,
    evidenceWatermark: null,
    publishedAtEpochMs: 1
};

interface SettlePair {
    readonly formation: GroupFormationView;
    readonly group: GroupSnapshot;
}

function createSettledPair(): SettlePair {
    const snapshot = createFormationSnapshot({ stage: 'active', formationEpoch: 2, causalRevision: HEAD });
    return {
        formation: createFormationView(snapshot.group, {
            lifecycleState: 'active',
            formationEpoch: 2,
            condition: 'active',
            coverageBasisLayoutIdentity: ACCEPTED,
            causalRevision: HEAD
        }),
        group: { ...snapshot, group: { ...snapshot.group, acceptedLayoutIdentity: ACCEPTED, activationStatus: STATUS } }
    };
}

function withGroup(pair: SettlePair, group: Partial<GroupSnapshot['group']>): SettlePair {
    return { ...pair, group: { ...pair.group, group: { ...pair.group.group, ...group } as GroupSnapshot['group'] } };
}

function toFormationPoll(): RallarBlackBoxTestLoopCommand {
    const { formation } = toAlmCellSettle(receiver);
    expect(formation).toHaveLength(1);
    expect(formation[0]?.kind).toBe('loop');
    return formation[0] as RallarBlackBoxTestLoopCommand;
}

/** The first attempt's children as the loop runs them: placeholders resolved and ids scoped to the attempt. */
function toFirstAttempt(poll: RallarBlackBoxTestLoopCommand): readonly RallarBlackBoxTestCommand[] {
    return poll.commands.map((template, commandIndex) =>
        toLoopChildCommand({
            template,
            context: { loopCommandId: poll.commandId!, index: 0, iteration: 1, elapsedMs: 0, commandIndex }
        })
    );
}

/** Runs the attempt's reads against the pair, then judges each of its facts over the resulting result cache. */
async function readAttemptFailures(pair: SettlePair): Promise<readonly string[]> {
    const bodies = new Map<string, GroupFormationView | GroupSnapshot>([[`${GROUP_PATH}/formation`, pair.formation], [GROUP_PATH, pair.group]]);
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        commandExecutor: (command): RallarBlackBoxTestCommandOutcome | undefined => {
            if (command.kind !== 'http.request') {
                return undefined;
            }
            const path = command.request.path ?? '';
            const body = bodies.get(path);
            return body === undefined
                ? { status: 'failed', error: { code: 'NOT_FOUND', message: path } }
                : { status: 'ok', value: { status: 200, body } };
        }
    });
    const attempt = toFirstAttempt(toFormationPoll());
    const reads = attempt.filter((command) => command.kind === 'http.request');
    for (const read of reads) {
        expect((await runtime.execute(read)).status, read.commandId).toBe('ok');
    }
    return attempt.flatMap((command) => {
        if (command.kind !== 'assert') {
            return [];
        }
        const outcome = computeAssertCommandOutcome({
            command: { ...command, commandId: command.commandId! },
            state: runtime.state(),
            config: undefined
        });
        return outcome.status === 'ok' ? [] : [command.commandId!.split(':').at(-1)!];
    });
}

describe('the settle\'s formation poll, one attempt', () => {
    it('reads the formation view, then the group, and judges only those two reads', () => {
        const attempt = toFirstAttempt(toFormationPoll());
        const reads = attempt.filter((command) => command.kind === 'http.request');

        expect(reads.map((command) => command.kind === 'http.request' && command.request.path))
            .toEqual([`${GROUP_PATH}/formation`, GROUP_PATH]);
        expect(attempt.slice(0, 2)).toEqual(reads);
        expect(attempt.slice(2).every((command) => command.kind === 'assert')).toBe(true);
    });

    it('accepts a settled pair', async () => {
        expect(await readAttemptFailures(createSettledPair())).toEqual([]);
    });

    it('refuses a pending set', async () => {
        const pair = createSettledPair();
        const pending = { reconfigureQueued: false, dueAtEpochMs: 5, generation: 1 };

        expect(await readAttemptFailures({ ...pair, formation: { ...pair.formation, pending } }))
            .toEqual([expect.stringContaining('formation-not-pending')]);
    });

    it('refuses layoutStale', async () => {
        const pair = createSettledPair();

        expect(await readAttemptFailures({ ...pair, formation: { ...pair.formation, layoutStale: true } }))
            .toEqual([expect.stringContaining('formation-layout-current')]);
    });

    it('refuses the two reads at different revisions', async () => {
        const pair = createSettledPair();
        const groupMoved = { ...pair.formation, causalRevision: { ...HEAD, groupRevision: HEAD.groupRevision + 1 } };
        const presenceMoved = { ...pair.formation, causalRevision: { ...HEAD, presenceRevision: HEAD.presenceRevision + 1 } };

        expect(await readAttemptFailures({ ...pair, formation: groupMoved }))
            .toEqual([expect.stringContaining('formation-at-group-groupRevision')]);
        expect(await readAttemptFailures({ ...pair, formation: presenceMoved }))
            .toEqual([expect.stringContaining('formation-at-group-presenceRevision')]);
    });

    it('refuses a status of an earlier formation epoch', async () => {
        expect(await readAttemptFailures(withGroup(createSettledPair(), { activationStatus: { ...STATUS, formationEpoch: 1 } })))
            .toEqual([expect.stringContaining('status-of-formation-epoch')]);
    });

    it('refuses a status on another layout', async () => {
        const basis = { ...ACCEPTED, version: ACCEPTED.version - 1 };

        expect(await readAttemptFailures(withGroup(createSettledPair(), { activationStatus: { ...STATUS, coverageBasisLayoutIdentity: basis } })))
            .toEqual([expect.stringContaining('status-on-accepted-version')]);
    });

    it('refuses no accepted layout', async () => {
        const failures = await readAttemptFailures(withGroup(createSettledPair(), { acceptedLayoutIdentity: null }));

        expect(failures).toEqual(['groupRevision', 'presenceRevision', 'version', 'state'].map((key) => expect.stringContaining(`status-on-accepted-${key}`)));
    });

    it('refuses no activation status', async () => {
        const failures = await readAttemptFailures(withGroup(createSettledPair(), { activationStatus: null }));

        expect(failures).toEqual([
            expect.stringContaining('status-of-formation-epoch'),
            ...['groupRevision', 'presenceRevision', 'version', 'state'].map((key) => expect.stringContaining(`status-on-accepted-${key}`))
        ]);
    });
});
