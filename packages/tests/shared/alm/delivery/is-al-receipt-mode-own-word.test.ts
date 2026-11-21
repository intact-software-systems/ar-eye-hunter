import { describe, expect, it } from 'vitest';

import type { ALAckAlgo } from '@shared/al-contracts/al-policy.ts';
import { isALReceiptModeOwnWord } from '@shared/alm/delivery/is-al-receipt-mode-own-word.ts';

const OWN = { fromPeerId: 'c', logicalRecipientPeerId: 'c' };
const OTHERS = { fromPeerId: 'b', logicalRecipientPeerId: 'c' };

describe('whether a receipt hears a control as its recipient\'s word', () => {
    it.each(
        [
            { mode: 'receiver', word: 'another\'s', control: OTHERS, heard: true },
            { mode: 'leader', word: 'another\'s', control: OTHERS, heard: true },
            { mode: 'hop', word: 'its own', control: OWN, heard: true },
            { mode: 'hop', word: 'another\'s', control: OTHERS, heard: false },
            { mode: 'subtree', word: 'another\'s', control: OTHERS, heard: false }
        ] satisfies readonly { mode: ALAckAlgo; word: string; control: typeof OWN; heard: boolean; }[]
    )('under $mode, a hop that speaks $word word: $heard', ({ mode, control, heard }) => {
        expect(isALReceiptModeOwnWord(mode, control)).toBe(heard);
    });
});
