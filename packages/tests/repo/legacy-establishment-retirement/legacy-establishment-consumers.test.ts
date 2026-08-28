import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
    LEGACY_ESTABLISHMENT_CONSUMERS,
    LEGACY_ESTABLISHMENT_EXCLUDED_PREFIX,
    LEGACY_ESTABLISHMENT_TOKENS,
    type LegacyEstablishmentConsumer,
    type LegacyEstablishmentToken
} from './legacy-establishment-consumers.ts';

/**
 * Slice 5d inventories what slice 8d removes; nothing leaves here. The
 * inventory is only worth having if it cannot be under-declared, so the
 * comparison runs in both directions over the whole tracked tree: a consumer
 * the table omits fails just as loudly as one it invents.
 */
describe('legacy start-establishment consumer inventory', () => {
    it('declares exactly the consumers the tracked tree carries, occurrence for occurrence', () => {
        expect(readDeclaredConsumers()).toEqual(readTrackedConsumers());
    });

    it('covers the command through its internal producer, not only its route', () => {
        const declared = new Set(LEGACY_ESTABLISHMENT_CONSUMERS.map((consumer) => consumer.file));

        // The retry leg builds the command directly and names no route, so a
        // route-keyed inventory cannot see it (product decision 34 calls it
        // out by name). It is the consumer 8d is most likely to miss.
        expect(declared).toContain(
            'packages/shared-server/rallar-system/group-state/group-formation-mutation-command.ts'
        );
        expect(declared).toContain(
            'packages/shared-server/rallar-system/topology/replay/work/create-formation-timer-work-handler.ts'
        );
    });

    it('excludes the design documents that describe the retirement', () => {
        for (const consumer of LEGACY_ESTABLISHMENT_CONSUMERS) {
            expect(consumer.file.startsWith(LEGACY_ESTABLISHMENT_EXCLUDED_PREFIX)).toBe(false);
        }
    });
});

function readDeclaredConsumers(): readonly LegacyEstablishmentConsumer[] {
    return [...LEGACY_ESTABLISHMENT_CONSUMERS].sort((left, right) => left.file.localeCompare(right.file));
}

function readTrackedConsumers(): readonly LegacyEstablishmentConsumer[] {
    return readTrackedFiles()
        .map((file) => ({ file, occurrences: readOccurrences(file) }))
        .filter((consumer) => Object.keys(consumer.occurrences).length > 0)
        .sort((left, right) => left.file.localeCompare(right.file));
}

function readTrackedFiles(): readonly string[] {
    return execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n')
        .filter((file) => file.length > 0 && !file.startsWith(LEGACY_ESTABLISHMENT_EXCLUDED_PREFIX))
        .filter((file) => !file.includes('legacy-establishment-retirement'))
        .filter((file) => isReadableFile(file));
}

function isReadableFile(file: string): boolean {
    try {
        return statSync(file).isFile();
    }
    catch {
        return false;
    }
}

function readOccurrences(file: string): Partial<Record<LegacyEstablishmentToken, number>> {
    const contents = readFileSync(file, 'utf8');
    const occurrences: Partial<Record<LegacyEstablishmentToken, number>> = {};
    for (const token of LEGACY_ESTABLISHMENT_TOKENS) {
        const count = contents.split(token).length - 1;
        if (count > 0) {
            occurrences[token] = count;
        }
    }
    return occurrences;
}
