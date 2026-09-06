import { describe, expect, it } from 'vitest';

import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { toRoomFormationDenial } from '@shared-web/browser/rooms/formation/to-room-formation-denial.ts';
import { GROUP_CONNECT_REJECTION_CODES } from '@shared/api/group-lifecycle/group-connect-rejection-codes.ts';
import { RallarValidationError } from '@shared/api/rallar-validation.ts';

function toFailureBody(code: string, status: number, denial: boolean): string {
    return JSON.stringify({
        type: 'api-mutation-failure',
        version: 'canonical.v2',
        code,
        status,
        message: `Rejected: ${code}`,
        issues: null,
        denial: denial ? { code, message: `Rejected: ${code}`, details: null } : null,
        retry: null
    });
}

describe('room formation denial reader', () => {
    it('classifies a policy denial', () => {
        const error = new ApiHttpError('POST', '/lifecycle/plan', 403, toFailureBody('lifecycle-transition-invalid', 403, true));

        expect(toRoomFormationDenial(error)).toEqual({
            kind: 'policy',
            code: 'lifecycle-transition-invalid',
            message: 'Rejected: lifecycle-transition-invalid'
        });
    });

    it.each([...GROUP_CONNECT_REJECTION_CODES])('classifies the %s connect conflict as the layout denial', (code) => {
        const error = new ApiHttpError('POST', '/lifecycle/connect', 409, toFailureBody(code, 409, false));

        expect(toRoomFormationDenial(error)).toEqual({ kind: 'layout', code, message: `Rejected: ${code}` });
    });

    it('classifies the local no-planned-layout refusal as the same layout denial', () => {
        const error = new RallarValidationError('Cannot connect room formation', [
            { path: '$.layout', code: 'no-planned-layout', message: 'No planned layout is published for this room.' }
        ]);

        expect(toRoomFormationDenial(error)).toEqual({
            kind: 'layout',
            code: 'group-connect-no-planned-layout',
            message: 'No planned layout is published for this room.'
        });
    });

    it('returns undefined for anything else', () => {
        expect(toRoomFormationDenial(new Error('network'))).toBeUndefined();
        expect(
            toRoomFormationDenial(
                new ApiHttpError('POST', '/lifecycle/connect', 400, toFailureBody('group-mutation-rejected', 400, false))
            )
        ).toBeUndefined();
    });
});
