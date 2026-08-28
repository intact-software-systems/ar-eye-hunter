import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
    LEGACY_ESTABLISHMENT_CONSUMERS,
    LEGACY_ESTABLISHMENT_EXCLUDED_PREFIXES,
    LEGACY_ESTABLISHMENT_SELF_PATH,
    LEGACY_ESTABLISHMENT_TOKENS,
    PRODUCTION_LEGACY_EXCEPTION_REGISTRY,
    type LegacyEstablishmentConsumer,
    type LegacyEstablishmentToken
} from './legacy-establishment-consumers.ts';

/**
 * Slice 5d inventories what slice 8d removes; nothing leaves here. A
 * one-directional check — every declared file still exists — passes with the
 * list almost entirely deleted, which is how the first draft shipped
 * incomplete. The comparison below therefore runs both ways over the tracked
 * tree, exact to the occurrence.
 */
describe('legacy start-establishment consumer inventory', () => {
    it('declares exactly the consumers the tracked tree carries, occurrence for occurrence', () => {
        const declared = getDeclaredConsumers();
        const tracked = readTrackedConsumers();

        // Compare the file list first: a fifty-entry table diff does not say
        // which file moved, and that is the whole message.
        expect(declared.map((consumer) => consumer.file)).toEqual(
            tracked.map((consumer) => consumer.file)
        );
        expect(declared).toEqual(tracked);
    });

    it('covers the retry leg through its producer and its scheduler', () => {
        const declared = new Set(LEGACY_ESTABLISHMENT_CONSUMERS.map((consumer) => consumer.file));

        // The producer builds the command and names no route; the scheduler
        // arms the retry and names no command. Product decision 34 re-expresses
        // this leg, so both are cutover work an inventory keyed on either half
        // alone would lose.
        for (
            const file of [
                'packages/shared-server/rallar-system/group-state/group-formation-mutation-command.ts',
                'packages/shared-server/rallar-system/topology/replay/work/create-formation-timer-work-handler.ts',
                'packages/shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts'
            ]
        ) {
            expect(declared, file).toContain(file);
        }
    });

    // Product decision 14 forbids retaining this command. The registry is the
    // only channel that could grant it an exception, so an entry appearing
    // there would turn this worklist into a retention list.
    it('holds no retained-legacy exception, so the worklist is a removal list', () => {
        const registry = readFileSync(PRODUCTION_LEGACY_EXCEPTION_REGISTRY, 'utf8');

        for (const token of LEGACY_ESTABLISHMENT_TOKENS) {
            expect(registry, `${PRODUCTION_LEGACY_EXCEPTION_REGISTRY} retains ${token}`)
                .not.toContain(token);
        }
    });

    it('excludes the prose roots that describe the retirement', () => {
        for (const consumer of LEGACY_ESTABLISHMENT_CONSUMERS) {
            for (const prefix of LEGACY_ESTABLISHMENT_EXCLUDED_PREFIXES) {
                expect(consumer.file.startsWith(prefix), consumer.file).toBe(false);
            }
        }
    });
});

function getDeclaredConsumers(): readonly LegacyEstablishmentConsumer[] {
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
        .filter((file) => file.length > 0)
        .filter((file) => !LEGACY_ESTABLISHMENT_EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
        .filter((file) => !file.includes(LEGACY_ESTABLISHMENT_SELF_PATH))
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
