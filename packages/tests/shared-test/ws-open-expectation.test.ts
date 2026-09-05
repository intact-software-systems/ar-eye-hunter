import { describe, expect, it } from 'vitest';

import {
    resolveWsOpenExpectation
} from '../../shared-test/black-box-runner/ws/ws-open-expectation.ts';

describe('resolveWsOpenExpectation', () => {
    it('leaves an ordinary open unchanged', () => {
        expect(resolveWsOpenExpectation({ expectation: {}, opened: true, close: undefined }))
            .toEqual({ satisfied: true });
    });

    it('leaves an ordinary failure unchanged', () => {
        expect(resolveWsOpenExpectation({ expectation: {}, opened: false, close: undefined }))
            .toEqual({ satisfied: false });
    });

    // The upgrade paths the coverage plan deferred: a refused upgrade is the
    // assertion, so it has to be expressible as a pass.
    it('treats a refused upgrade as satisfied when rejection is expected', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true },
            opened: false,
            close: { code: 1008, reason: 'unauthorized' }
        });

        expect(result.satisfied).toBe(true);
    });

    it('treats a successful open as a failure when rejection is expected', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true },
            opened: true,
            close: undefined
        });

        expect(result.satisfied).toBe(false);
        expect(result.message).toContain('rejected');
    });

    it('pins the close code when one is expected', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true, close: { code: 1008 } },
            opened: false,
            close: { code: 1008, reason: 'unauthorized' }
        });

        expect(result.satisfied).toBe(true);
    });

    it('rejects a refusal that closed with a different code', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true, close: { code: 1008 } },
            opened: false,
            close: { code: 1011, reason: 'server error' }
        });

        expect(result.satisfied).toBe(false);
        expect(result.message).toContain('1008');
    });

    it('rejects a refusal with no close event when a code is expected', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true, close: { code: 1008 } },
            opened: false,
            close: undefined
        });

        expect(result.satisfied).toBe(false);
    });
});
