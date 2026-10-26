import {
    defineRallarAiTransportPolicy
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

describe('RallarAI transport policy', () => {
    it('defines transport policy defaults', () => {
        expect(defineRallarAiTransportPolicy({
            delivery: 'persisted'
        })).toMatchObject({
            delivery: 'persisted',
            ordering: 'none',
            acknowledgement: 'none',
            conflictPolicy: 'app-defined'
        });
    });
});
