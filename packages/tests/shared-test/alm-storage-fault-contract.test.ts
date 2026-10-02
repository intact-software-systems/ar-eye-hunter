import { describe, expect, it } from 'vitest';

import { decodeBlackBoxRallarFaultInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/decode-black-box-rallar-messaging-input.ts';
import { validateAlmControlCommand } from '@shared-test/rallar-bb-test/alm/validate-alm-control-command.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';

describe('ALM storage fault command', () => {
    const command = {
        kind: 'fault.inject',
        faultId: 'quota-admission',
        carrier: 'storage',
        match: { owner: 'al-admission', kind: 'write' },
        action: 'quota',
        remaining: 'until-cleared'
    };

    it.each([
        { action: 'quota', match: { owner: 'al-admission', kind: 'write' } },
        { action: 'fail', match: { owner: 'al-work' } },
        { action: { delayMs: 25 }, match: { owner: 'al-work', kind: 'work-page' } }
    ])(
        'admits the storage fault $action on $match.owner through every command boundary',
        ({ action, match }) => {
            const fault = { ...command, action, match };
            expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, fault).ok).toBe(true);
            expect(validateAlmControlCommand(fault, 'fault.inject')).toEqual([]);
            expect(decodeBlackBoxRallarFaultInput(fault).right).toEqual({
                faultId: 'quota-admission',
                carrier: 'storage',
                match: { owner: match.owner, kind: match.kind },
                action,
                remaining: 'until-cleared'
            });
        }
    );

    it.each([
        { name: 'a transport action', fault: { ...command, action: 'drop' } },
        { name: 'a missing owner', fault: { ...command, match: { kind: 'write' } } },
        { name: 'an unknown owner', fault: { ...command, match: { owner: 'al-cache' } } },
        {
            name: 'an unknown kind',
            fault: { ...command, match: { owner: 'al-admission', kind: 'commit' } }
        },
        {
            name: 'a transport matcher',
            fault: { ...command, match: { owner: 'al-admission', typeId: 'held' } }
        }
    ])('refuses $name on the storage carrier before runtime invocation', ({ fault }) => {
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, fault).ok).toBe(false);
        expect(validateAlmControlCommand(fault, 'fault.inject').length).toBeGreaterThan(0);
    });

    it.each([
        { name: 'a transport action', fault: { ...command, action: 'drop' } },
        { name: 'a missing owner', fault: { ...command, match: { kind: 'write' } } },
        {
            name: 'an unknown kind',
            fault: { ...command, match: { owner: 'al-admission', kind: 'commit' } }
        }
    ])('the page decoder refuses $name on the storage carrier', ({ fault }) => {
        expect(decodeBlackBoxRallarFaultInput(fault).left).toBeDefined();
    });

    it('refuses a storage matcher on a transport carrier', () => {
        const fault = { ...command, carrier: 'ws', action: 'drop' };
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_COMMAND_SCHEMA, fault).ok).toBe(false);
        expect(validateAlmControlCommand(fault, 'fault.inject').length).toBeGreaterThan(0);
    });
});
