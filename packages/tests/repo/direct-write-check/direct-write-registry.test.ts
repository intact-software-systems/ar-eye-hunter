import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    toApprovedStoreIds,
    toDirectWriteRegistry,
    validateDirectWriteRegistry
} from '../../../../scripts/direct-write-check/direct-write-registry.mjs';

const FENCE = 'app-inbox-direct-write-registry-v1';
const REGISTRY_PATH = 'docs/app-inbox-direct-write-registry.md';
/**
 * The stores the maintainer has approved to write outside AppInbox, by id. Moving an entry to approved needs an
 * edit here, in a diff whose only content is that id. Owner: repository-governance maintainers. Removal condition:
 * the maintainer's revisit has ruled on every under-review store.
 */
const APPROVED_DIRECT_WRITE_IDS: readonly string[] = [];

describe('direct-write registry contract', () => {
    it('accepts a registry whose store is under review and one whose store carries a complete approval', () => {
        expect(validateDirectWriteRegistry(registryWith({}))).toEqual([]);
        expect(validateDirectWriteRegistry(registryWith({ review: approvedReview() }))).toEqual([]);
    });

    it('reads the one fenced block and refuses a document without it or with broken JSON', () => {
        const registry = registryWith({});

        expect(toDirectWriteRegistry(toDocument(JSON.stringify(registry)))).toEqual({
            kind: 'parsed',
            registry
        });
        expect(toDirectWriteRegistry('# Registry\n\nNo block here.\n')).toEqual({
            kind: 'invalid',
            issues: [`the document holds no \`\`\`${FENCE} block`]
        });
        expect(toDirectWriteRegistry(toDocument('{ "version": 1, '))).toMatchObject({
            kind: 'invalid',
            issues: [expect.stringMatching(/^the registry block is not valid JSON: /u)]
        });
        expect(
            toDirectWriteRegistry(`${toDocument(JSON.stringify(registry))}\n${toDocument('{}')}`)
        ).toEqual({ kind: 'invalid', issues: [`the document holds 2 \`\`\`${FENCE} blocks; it must hold one`] });
    });

    it('refuses a surface with an unknown class, a placeholder basis, or an identity used twice', () => {
        const surface = { id: 'packages/a.ts#writeRows', class: 'downstream-work', basis: concreteBasis() };
        const registry = registryWith({
            transactionOpeners: [
                { ...surface, class: 'exempt' },
                { ...surface, id: 'packages/b.ts#writeRows', basis: 'TBD' },
                surface,
                surface
            ]
        });

        expect(validateDirectWriteRegistry(registry)).toEqual([
            'transactionOpeners packages/a.ts#writeRows: unknown class "exempt"',
            'transactionOpeners packages/b.ts#writeRows: basis must say what was verified, not placeholder text',
            'transactionOpeners packages/a.ts#writeRows: the identity is registered 3 times'
        ]);
    });

    it('refuses a transport store without review, rows or incoming paths, and a surface naming no store', () => {
        const registry = registryWith({});
        const store = { id: 'alm-example-store', class: 'transport-direct' };
        const surfaces = [
            { id: 'packages/a.ts#write', class: 'transport-direct', basis: concreteBasis() },
            { id: 'packages/b.ts#write', class: 'transport-direct', basis: concreteBasis(), stores: ['alm-missing'] }
        ];

        expect(
            validateDirectWriteRegistry({ ...registry, stores: [store], admissionBackendWrites: surfaces })
        ).toEqual([
            'stores alm-example-store: review is required',
            'stores alm-example-store: rows must list every row written',
            'stores alm-example-store: incomingPaths must list every incoming path that writes',
            'admissionBackendWrites packages/a.ts#write: a transport-direct surface names the stores it writes',
            'admissionBackendWrites packages/b.ts#write: unknown store "alm-missing"'
        ]);
    });

    it('refuses an under-review store that carries any part of an answer, and a surface that carries a review', () => {
        const registry = registryWith({
            review: {
                state: 'under-review',
                since: '2026-11-27',
                raised: 'The maintainer revisit of 2026-11-27.',
                answer: 'Keep it.',
                question: 'Keep it?'
            }
        });
        const surfaceWithReview = {
            id: 'packages/a.ts#writeRows',
            class: 'downstream-work',
            basis: concreteBasis(),
            review: approvedReview()
        };

        expect(validateDirectWriteRegistry({ ...registry, transactionOpeners: [surfaceWithReview] })).toEqual([
            'stores alm-example-store: an under-review entry carries no answer field',
            'stores alm-example-store: an under-review entry carries no question field',
            'transactionOpeners packages/a.ts#writeRows: only a transport store carries a review; this entry carries review'
        ]);
    });

    it('refuses an approval that is incomplete, placeholder, unasked under the rule, or dated before the rule', () => {
        const registry = registryWith({
            review: {
                state: 'approved',
                question: 'May the store keep writing directly?',
                options: ['Keep the direct write.'],
                recommended: 'Move it.',
                costOfAppInbox: '',
                answer: '<the maintainer answer>',
                answeredOn: '2026-11-22'
            }
        });

        expect(validateDirectWriteRegistry(registry)).toEqual([
            'stores alm-example-store: the question must contain "outside AppInbox"',
            'stores alm-example-store: options must list at least two options word for word',
            'stores alm-example-store: one option must name AppInbox as the path',
            'stores alm-example-store: recommended must be one of the options',
            'stores alm-example-store: costOfAppInbox must be a measurement or exactly "not measured"',
            'stores alm-example-store: answer must be the maintainer answer word for word, not placeholder text',
            'stores alm-example-store: answeredOn must not be before 2026-11-27, the day the rule was made'
        ]);
    });

    it('refuses a bracketed question, a date that is not a date, and an unknown review state', () => {
        const bracketed = registryWith({
            review: { ...approvedReview(), question: '[the question outside AppInbox]', answeredOn: '27 November' }
        });
        const unknownState = registryWith({ review: { state: 'accepted' } });

        expect(validateDirectWriteRegistry(bracketed)).toEqual([
            'stores alm-example-store: question must be the question word for word, not placeholder text',
            'stores alm-example-store: answeredOn must be an ISO date (YYYY-MM-DD)'
        ]);
        expect(validateDirectWriteRegistry(unknownState)).toEqual([
            'stores alm-example-store: review.state must be "under-review" or "approved"'
        ]);
    });
});

describe('the committed direct-write registry', () => {
    const document = readFileSync(path.join(process.cwd(), REGISTRY_PATH), 'utf8');
    const read = toDirectWriteRegistry(document);
    const registry = read.kind === 'parsed' ? read.registry : {};

    it('is one valid block whose approved stores are exactly the pinned list, which is empty', () => {
        expect(read.kind).toBe('parsed');
        expect(validateDirectWriteRegistry(registry)).toEqual([]);
        expect(toApprovedStoreIds(registry)).toEqual([...APPROVED_DIRECT_WRITE_IDS].toSorted());
        expect(APPROVED_DIRECT_WRITE_IDS).toEqual([]);
    });

    it('keeps every transport-direct store under review and says that no entry is approved', () => {
        const stores = (registry as { readonly stores?: readonly { readonly id: string; readonly review?: { readonly state?: string; }; }[]; }).stores ?? [];

        expect(stores.map((store) => [store.id, store.review?.state])).toEqual([
            ['alm-inbound-admission', 'under-review'],
            ['alm-outbound-admission', 'under-review'],
            ['alm-receipt-record', 'under-review']
        ]);
        expect(document.replace(/\s+/gu, ' ')).toContain(
            'An entry records that a write exists. It is not an approval. No entry in this file is approved.'
        );
    });
});

interface RegistryOverrides {
    readonly review?: Readonly<Record<string, unknown>>;
    readonly transactionOpeners?: readonly Readonly<Record<string, unknown>>[];
}

function registryWith(overrides: RegistryOverrides): Readonly<Record<string, unknown>> {
    return {
        version: 1,
        owner: 'Repository-governance maintainers',
        reviewCondition: 'Every under-review store is ruled on at the maintainer revisit.',
        wiringModules: ['packages/server/wiring.ts'],
        repositoryContractModules: ['packages/server/repository.ts'],
        keyModules: ['packages/shared/keys.ts'],
        workTopicConstants: [{ path: 'packages/shared/topics.ts', name: 'WORK_TOPICS' }],
        stores: [
            {
                id: 'alm-example-store',
                class: 'transport-direct',
                rows: ['One owner row per message in runtime_state_store.'],
                incomingPaths: ['A WebSocket frame admitted by the socket handler.'],
                review: overrides.review ?? underReview()
            }
        ],
        admissionBackendImplementations: [],
        admissionBackendConstructions: [],
        admissionBackendWrites: [],
        wiringImports: [],
        transactionOpeners: overrides.transactionOpeners ?? [],
        sqlWriteFiles: [],
        nonTransactionHandleFeeds: [],
        repositoryWriteCallers: [],
        rowFamilies: []
    };
}

function underReview(): Readonly<Record<string, unknown>> {
    return { state: 'under-review', since: '2026-11-27', raised: 'The maintainer revisit of 2026-11-27.' };
}

function approvedReview(): Readonly<Record<string, unknown>> {
    return {
        state: 'approved',
        question: 'This writes outside AppInbox: may the store keep its own transaction?',
        options: ['Keep the direct write.', 'Move the write through AppInbox.'],
        recommended: 'Move the write through AppInbox.',
        costOfAppInbox: 'not measured',
        answer: 'Move the write through AppInbox.',
        answeredOn: '2026-11-28'
    };
}

function concreteBasis(): string {
    return 'Read the opener and its worker trigger in the named file.';
}

function toDocument(block: string): string {
    return `# Registry\n\n\`\`\`${FENCE}\n${block}\n\`\`\`\n`;
}
