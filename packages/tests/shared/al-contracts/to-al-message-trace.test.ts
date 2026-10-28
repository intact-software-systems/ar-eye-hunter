import { describe, expect, it } from 'vitest';

import { newALRoute, newALUntargetedMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALMessageTrace, toALMessageTraceOrNull } from '@shared/al-contracts/trace/to-al-message-trace.ts';

const ROUTE = newALRoute('app.command', 'room-1', 'resource-1');

function newMessage(actions?: ALMessage['actions']): ALMessage {
    return newALUntargetedMessage('client', ROUTE, 'app.ask.v1', { q: 1 }, { traceId: 'trace-x', actions });
}

describe('the trace of a message', () => {
    it('names the envelope trace and the correlation the message carries', () => {
        expect(toALMessageTrace(newMessage({ corrId: 'corr-y' }))).toEqual({ traceId: 'trace-x', corrId: 'corr-y' });
    });

    it('correlates a message that carries no corrId under its own msgId', () => {
        const message = newMessage();

        expect(toALMessageTrace(message)).toEqual({ traceId: 'trace-x', corrId: message.id.msgId });
    });

    it('lists the trace before the correlation, so a diagnostic that spreads it ends with the correlation', () => {
        expect(Object.keys(toALMessageTrace(newMessage()))).toEqual(['traceId', 'corrId']);
    });
});

describe('the trace of a message a producer may not hold', () => {
    it('is the message trace when the message is present', () => {
        expect(toALMessageTraceOrNull(newMessage({ corrId: 'corr-y' }))).toEqual({
            traceId: 'trace-x',
            corrId: 'corr-y'
        });
    });

    it('is null in both fields when the message is absent', () => {
        expect(toALMessageTraceOrNull(undefined)).toEqual({ traceId: null, corrId: null });
    });
});
