import { describe, expect, it } from 'vitest';

import { toEvaluatedWorkflowText } from './to-evaluated-workflow-text.ts';

const values = { 'matrix.carrier': 'rtc', 'matrix.families': 'two-agent,addressed', 'inputs.families': '' };

describe('toEvaluatedWorkflowText', () => {
    it.each([
        { text: '(${{ matrix.carrier }})', evaluated: '(rtc)' },
        { text: '(${{matrix.carrier}})', evaluated: '(rtc)' },
        { text: '(${{   matrix.carrier   }})', evaluated: '(rtc)' },
        { text: '(${{ matrix.families && format(\', {0}\', matrix.families) || \'\' }})', evaluated: '(, two-agent,addressed)' },
        { text: '(${{matrix.families && format(\', {0}\', matrix.families) || \'\'}})', evaluated: '(, two-agent,addressed)' },
        { text: 'x${{ inputs.families && format(\'-{0}\', inputs.families) || \'\' }}', evaluated: 'x' }
    ])('evaluates $text as $evaluated', ({ text, evaluated }) => {
        expect(toEvaluatedWorkflowText(text, values)).toBe(evaluated);
    });

    it.each([
        { text: '${{ matrix.carrier || \'ws\' }}', error: 'Unsupported workflow expression: matrix.carrier || \'ws\'' },
        {
            text: '${{ matrix.carrier && format(\'-{0}\', matrix.families) || \'\' }}',
            error: 'Unsupported workflow expression: matrix.carrier && format(\'-{0}\', matrix.families) || \'\''
        },
        { text: '${{ inputs.carrier }}', error: 'No value for the workflow reference inputs.carrier' },
        { text: '${{}}', error: 'Unevaluated workflow expression in ${{}}' },
        { text: 'name-${{ matrix.carrier', error: 'Unevaluated workflow expression in name-${{ matrix.carrier' }
    ])('throws for $text', ({ text, error }) => {
        expect(() => toEvaluatedWorkflowText(text, values)).toThrow(error);
    });
});
