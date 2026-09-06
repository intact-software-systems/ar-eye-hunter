import { describe, expect, it } from 'vitest';

import {
    resolveWsOpenExpectation
} from '../../shared-test/black-box-runner/ws/ws-open-expectation.ts';

describe('resolveWsOpenExpectation', () => {
    it('leaves an ordinary open unchanged', () => {
        expect(resolveWsOpenExpectation({ expectation: {}, outcome: 'opened', close: undefined }))
            .toEqual({ satisfied: true });
    });

    it('leaves an ordinary failure unchanged', () => {
        expect(resolveWsOpenExpectation({ expectation: {}, outcome: 'refused', close: undefined }))
            .toEqual({ satisfied: false });
    });

    // The upgrade paths the coverage plan deferred: a refused upgrade is the
    // assertion, so it has to be expressible as a pass.
    it('treats a refused upgrade as satisfied when rejection is expected', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true },
            outcome: 'refused',
            close: { code: 1008, reason: 'unauthorized' }
        });

        expect(result.satisfied).toBe(true);
    });

    it('treats a successful open as a failure when rejection is expected', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true },
            outcome: 'opened',
            close: undefined
        });

        expect(result.satisfied).toBe(false);
        expect(result.message).toContain('rejected');
    });

    // A server that never answers has refused nothing. Accepting a timeout
    // would let the assertion pass against an API that was never started.
    it('does not accept a connect timeout as a refusal', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true },
            outcome: 'timedOut',
            close: undefined
        });

        expect(result.satisfied).toBe(false);
        expect(result.message).toContain('never answered');
    });

    it('does not accept a transport error as a refusal', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true },
            outcome: 'errored',
            close: undefined
        });

        expect(result.satisfied).toBe(false);
        expect(result.message).toContain('transport failed');
    });

    it('pins the close code when one is expected', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true, close: { code: 1008 } },
            outcome: 'refused',
            close: { code: 1008, reason: 'unauthorized' }
        });

        expect(result.satisfied).toBe(true);
    });

    it('rejects a refusal that closed with a different code', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true, close: { code: 1008 } },
            outcome: 'refused',
            close: { code: 1011, reason: 'server error' }
        });

        expect(result.satisfied).toBe(false);
        expect(result.message).toContain('1008');
    });

    it('rejects a refusal with no close event when a code is expected', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true, close: { code: 1008 } },
            outcome: 'refused',
            close: undefined
        });

        expect(result.satisfied).toBe(false);
    });

    // A declared reason that is never compared is an expectation that cannot
    // fail, which is the shape this whole assertion exists to remove.
    it('pins the close reason when one is expected', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true, close: { reason: 'ticket-consumed' } },
            outcome: 'refused',
            close: { code: 1008, reason: 'ticket-consumed' }
        });

        expect(result.satisfied).toBe(true);
    });

    it('rejects a refusal that closed for a different reason', () => {
        const result = resolveWsOpenExpectation({
            expectation: { rejected: true, close: { reason: 'ticket-consumed' } },
            outcome: 'refused',
            close: { code: 1008, reason: 'group-full' }
        });

        expect(result.satisfied).toBe(false);
        expect(result.message).toContain('ticket-consumed');
    });
});
