import { describe, expect, it } from 'vitest';

import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_COMMAND_CAPABILITIES } from '@shared-test/rallar-bb-test/schema/rallar-black-box-command-capabilities.ts';

import {
    computeAlmMessagesReceivedBoundaryAdmission,
    toAlmMessagesReceivedCommand
} from './alm-messages-received-boundaries.ts';

describe('a sample-age reading in a messages.received command', () => {
    it.each([
        ['an age reading', { ageFrom: 'sentAtEpochMs' }],
        ['an age reading beside a presence claim', { ageFrom: 'sentAtEpochMs', absent: false }],
        ['an age reading beside an order claim and a stall window', {
            ageFrom: 'sentAtEpochMs',
            ascendingBy: 'seq',
            stallMs: 1_000
        }]
    ])('admits %s through schema and command validation', (_label, fields) => {
        expect(computeAlmMessagesReceivedBoundaryAdmission(toAlmMessagesReceivedCommand(fields))).toEqual({ schema: true, command: true });
    });

    it.each([
        ['an empty field name', { ageFrom: '' }],
        ['a blank field name', { ageFrom: '  ' }],
        ['a field name that is no string', { ageFrom: 3 }]
    ])('refuses %s at both boundaries', (_label, fields) => {
        expect(computeAlmMessagesReceivedBoundaryAdmission(toAlmMessagesReceivedCommand(fields))).toEqual({ schema: false, command: false });
    });

    it('refuses an age reading beside an absence claim, which asks for no copy, and says why', () => {
        const absence = toAlmMessagesReceivedCommand({ ageFrom: 'sentAtEpochMs', absent: true });

        expect(computeAlmMessagesReceivedBoundaryAdmission(absence)).toEqual({ schema: true, command: false });
        expect(validateAlmControlCommand(absence, 'messages.received').map((issue) => issue.message)).toEqual([
            'messages.received.ageFrom reads the age of the copies a count asks for, which an absence claim ' +
            '(absent: true) asks for none of.'
        ]);
    });

    it('names ageFrom in the capability an author reads: among its optional fields and in its description', () => {
        const capability = RALLAR_BLACK_BOX_COMMAND_CAPABILITIES.find(({ kind }) => kind === 'messages.received');

        expect(capability?.optionalFields).toContain('ageFrom');
        expect(capability?.description).toContain('ageFrom');
        expect(capability?.description).toContain('sampleAge');
    });
});
