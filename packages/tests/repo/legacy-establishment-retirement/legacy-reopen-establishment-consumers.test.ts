import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
    LEGACY_ESTABLISHMENT_EXCLUDED_PREFIXES,
    LEGACY_ESTABLISHMENT_SELF_PATH,
    PRODUCTION_LEGACY_EXCEPTION_REGISTRY
} from './legacy-establishment-consumers.ts';
import {
    LEGACY_REOPEN_ESTABLISHMENT_CONSUMERS,
    LEGACY_REOPEN_ESTABLISHMENT_TOKENS,
    type LegacyReopenEstablishmentConsumer,
    type LegacyReopenEstablishmentToken
} from './legacy-reopen-establishment-consumers.ts';

/**
 * Slice 6a records the public reopening command as removal work for slice
 * 8d. Exact reverse scanning makes a route, OpenAPI, recipe, type, or
 * operation consumer impossible to omit from the worklist silently.
 */
describe('legacy reopen-establishment consumer inventory', () => {
    it('declares exactly the tracked consumers, occurrence for occurrence', () => {
        expect(getDeclaredConsumers()).toEqual(readTrackedConsumers());
    });

    it('includes the public route, OpenAPI, and black-box recipe consumers', () => {
        const declared = new Set(LEGACY_REOPEN_ESTABLISHMENT_CONSUMERS.map((consumer) => consumer.file));
        for (
            const file of [
                'apps/api-v1/resources/api-v1-openapi.yaml',
                'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts',
                'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-lifecycle-transitions.json'
            ]
        ) {
            expect(declared, file).toContain(file);
        }
    });

    it('holds no retained-legacy exception, so the inventory remains a removal worklist', () => {
        const registry = readFileSync(PRODUCTION_LEGACY_EXCEPTION_REGISTRY, 'utf8');
        for (const token of LEGACY_REOPEN_ESTABLISHMENT_TOKENS) {
            expect(registry, `${PRODUCTION_LEGACY_EXCEPTION_REGISTRY} retains ${token}`)
                .not.toContain(token);
        }
    });

    it('excludes prose roots that only describe the future retirement', () => {
        for (const consumer of LEGACY_REOPEN_ESTABLISHMENT_CONSUMERS) {
            for (const prefix of LEGACY_ESTABLISHMENT_EXCLUDED_PREFIXES) {
                expect(consumer.file.startsWith(prefix), consumer.file).toBe(false);
            }
        }
    });
});

function getDeclaredConsumers(): readonly LegacyReopenEstablishmentConsumer[] {
    return [...LEGACY_REOPEN_ESTABLISHMENT_CONSUMERS].sort((left, right) => left.file.localeCompare(right.file));
}

function readTrackedConsumers(): readonly LegacyReopenEstablishmentConsumer[] {
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

function readOccurrences(file: string): Partial<Record<LegacyReopenEstablishmentToken, number>> {
    const contents = readFileSync(file, 'utf8');
    const occurrences: Partial<Record<LegacyReopenEstablishmentToken, number>> = {};
    for (const token of LEGACY_REOPEN_ESTABLISHMENT_TOKENS) {
        const count = contents.split(token).length - 1;
        if (count > 0) {
            occurrences[token] = count;
        }
    }
    return occurrences;
}
