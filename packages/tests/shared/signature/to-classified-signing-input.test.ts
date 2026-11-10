import { describe, expect, it } from 'vitest';

import { toClassifiedSigningInput, type ClassifiedSigningSection } from '@shared/signature/to-classified-signing-input.ts';

describe('toClassifiedSigningInput', () => {
    it('leads with the domain tag, then every signed slot in table order, an absent one null', () => {
        expect(
            toClassifiedSigningInput('tag-v1', [
                { name: 's', fields: { a: 1, c: 'x' }, classes: { a: 'signed', b: 'signed', c: 'excluded' } }
            ])
        ).toBe('["tag-v1",1,null]');
    });

    it('appends a present later field after every slot of every section, named by its path', () => {
        const sectionsWith = (late: number | undefined): ClassifiedSigningSection[] => [
            {
                name: 's',
                fields: { a: 1, late },
                classes: { a: 'signed', late: 'signed-when-present' }
            },
            { name: 't', fields: { b: 2 }, classes: { b: 'signed' } }
        ];
        expect(toClassifiedSigningInput('tag-v1', sectionsWith(3))).toBe('["tag-v1",1,2,["s.late",3]]');
        expect(toClassifiedSigningInput('tag-v1', sectionsWith(undefined))).toBe('["tag-v1",1,2]');
    });

    it('signs every slot of an absent section as null', () => {
        expect(
            toClassifiedSigningInput('tag-v1', [
                { name: 's', fields: undefined, classes: { a: 'signed', b: 'signed', c: 'excluded' } }
            ])
        ).toBe('["tag-v1",null,null]');
    });

    it('gives the same fields different bytes under another domain tag', () => {
        const sections: ClassifiedSigningSection[] = [{ name: 's', fields: { a: 1 }, classes: { a: 'signed' } }];
        expect(toClassifiedSigningInput('tag-v1', sections)).not.toBe(toClassifiedSigningInput('tag-v2', sections));
    });
});
