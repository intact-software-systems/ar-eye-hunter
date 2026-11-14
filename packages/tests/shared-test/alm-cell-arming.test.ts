import {
    describe,
    expect,
    it
} from 'vitest';

import { toRtcDropFaultCommand } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-fault-commands.ts';
import type { AlmConformanceStepInput } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-scenario-definition.ts';
import { toStatsCommand } from '@shared-test/rallar-bb-test/conformance/alm/alm-conformance-session-commands.ts';
import { toAlmCellArming } from '@shared-test/rallar-bb-test/conformance/alm/cell/to-alm-cell-arming.ts';
import {
    toCueListenCommands,
    toCueSendCommands
} from '@shared-test/rallar-bb-test/conformance/alm/scenarios/topic-subscription/topic-subscription-publications.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { toConformanceInput } from './alm-conformance-test-input.ts';

const step: AlmConformanceStepInput = {
    input: toConformanceInput('rtc'),
    scenarioId: 'granted-rtc-delivered',
    scenarioKey: 'granted-rtc-delivered',
    role: 'receiver',
    roles: ['sender', 'receiver'],
    messages: {},
    connect: undefined
};

function toFault(name: string): RallarBlackBoxTestCommand {
    return toRtcDropFaultCommand(step, name, 'until-cleared');
}

const subscription = toCueListenCommands(step);
const send = toStatsCommand(step, 'stats');
const readyCue = toCueSendCommands(step, 'ready');

describe('the arming run of a cell role\'s body', () => {
    it('takes the leading fault injections', () => {
        const body = [toFault('a'), toFault('b'), send];

        expect(toAlmCellArming(body)).toEqual({ arming: [toFault('a'), toFault('b')], rest: [send] });
    });

    it('takes a leading cue subscription', () => {
        const body = [...subscription, ...readyCue];

        expect(subscription).toHaveLength(2);
        expect(toAlmCellArming(body)).toEqual({ arming: subscription, rest: readyCue });
    });

    it('takes faults and a cue subscription in either order', () => {
        expect(toAlmCellArming([toFault('a'), ...subscription, send]))
            .toEqual({ arming: [toFault('a'), ...subscription], rest: [send] });
        expect(toAlmCellArming([...subscription, toFault('a'), send]))
            .toEqual({ arming: [...subscription, toFault('a')], rest: [send] });
    });

    it('stops at the first other command, later faults and subscriptions stay in the rest', () => {
        const body = [toFault('a'), ...readyCue, toFault('b'), ...subscription];

        expect(toAlmCellArming(body)).toEqual({ arming: [toFault('a')], rest: [...readyCue, toFault('b'), ...subscription] });
    });

    it('returns an empty arming run for a body that leads with a send', () => {
        const body = [...readyCue, ...subscription];

        expect(toAlmCellArming(body)).toEqual({ arming: [], rest: body });
    });
});
