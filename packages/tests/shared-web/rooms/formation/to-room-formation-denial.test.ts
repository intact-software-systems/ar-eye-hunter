import { describe, expect, it } from 'vitest';

import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { toRoomFormationDenial } from '@shared-web/browser/rooms/formation/to-room-formation-denial.ts';

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

    it('classifies a connect layout conflict', () => {
        const error = new ApiHttpError(
            'POST',
            '/lifecycle/connect',
            409,
            toFailureBody('group-connect-planned-layout-superseded', 409, false)
        );

        expect(toRoomFormationDenial(error)).toEqual({
            kind: 'layout',
            code: 'group-connect-planned-layout-superseded',
            message: 'Rejected: group-connect-planned-layout-superseded'
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
