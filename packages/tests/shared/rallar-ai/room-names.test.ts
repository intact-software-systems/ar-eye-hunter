import {
    createRallarAiFunnyRoomName,
    createRallarAiRoomNameSeed
} from '@shared/rallar-ai/mod.ts';
import { describe, expect, it } from 'vitest';

describe('RallarAI room names', () => {
    it('creates deterministic funny room names from a consumer vocabulary', () => {
        const theme = { id: 'workshop', defaultBaseName: 'Workshop', nouns: ['Anvil', 'Lathe'] };
        const first = createRallarAiFunnyRoomName({
            baseName: '',
            theme,
            seed: 'workshop-seed-1'
        });
        const same = createRallarAiFunnyRoomName({
            baseName: '',
            theme,
            seed: 'workshop-seed-1'
        });
        const different = createRallarAiFunnyRoomName({
            baseName: '',
            theme,
            seed: 'workshop-seed-2'
        });

        expect(first).toBe(same);
        expect(first).not.toBe(different);
        expect(first).toMatch(/^Workshop: [A-Za-z]+ (Anvil|Lathe) #[0-9A-F]{6}$/);
        expect(first.length).toBeLessThanOrEqual(72);
    });

    it('avoids funny room name collisions and keeps fallback names compact', () => {
        const theme = { id: 'workshop', defaultBaseName: 'Workshop', nouns: ['Anvil', 'Lathe'] };
        const existingNames: string[] = [];

        for (let index = 0; index < 70; index += 1) {
            const name = createRallarAiFunnyRoomName({
                baseName: 'Workshop',
                theme,
                seed: 'crowded-workshop',
                existingNames
            });

            expect(existingNames.map((existing) => existing.toLowerCase()))
                .not.toContain(name.toLowerCase());
            expect(name).toContain('Workshop');
            expect(name).toMatch(/^Workshop: .+ #[0-9A-F]{6}/);
            expect(name.length).toBeLessThanOrEqual(72);
            existingNames.push(name);
        }

        expect(new Set(existingNames).size).toBe(existingNames.length);
    });

    it('avoids normalized case-insensitive room name collisions', () => {
        const theme = { id: 'workshop', defaultBaseName: 'Workshop', nouns: ['Anvil'] };
        const first = createRallarAiFunnyRoomName({ baseName: '', theme, seed: 'collision' });
        const next = createRallarAiFunnyRoomName({
            baseName: '',
            theme,
            seed: 'collision',
            existingNames: [`  ${first.toLowerCase().replace(/ /g, '   ')}  `]
        });
        expect(next).not.toBe(first);
    });

    it.each([
        { id: '', defaultBaseName: 'Workshop', nouns: ['Anvil'] },
        { id: 'workshop', defaultBaseName: '   ', nouns: ['Anvil'] },
        { id: 'workshop', defaultBaseName: 'Workshop', nouns: [] },
        { id: 'workshop', defaultBaseName: 'Workshop', nouns: [' '] }
    ])('rejects incomplete room name theme configuration %#', (theme) => {
        expect(() => createRallarAiFunnyRoomName({ baseName: '', theme, seed: 'invalid' }))
            .toThrow('Room name theme requires a nonempty ID, default base name, and noun vocabulary');
    });

    it('creates room name seeds with the requested prefix', () => {
        expect(createRallarAiRoomNameSeed('test-room')).toMatch(/^test-room:/);
    });
});
