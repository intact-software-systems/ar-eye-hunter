// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    deriveSharedTestArtifactIndexPresentation,
    deriveSharedTestCompactionSummaryWindow,
    moveSharedTestCompactionSummaryWindow,
    SHARED_TEST_COMPACTION_SUMMARY_WINDOW_SIZE
} from '../../../apps/rallar-black-box/src/legacy/runner/shared-test/shared-test-artifact-index-presentation.ts';
import { SharedTestArtifactIndexPanel } from '../../../apps/rallar-black-box/src/legacy/runner/shared-test/SharedTestArtifactIndexPanel.tsx';
import {
    parseRallarBlackBoxSharedTestArtifactBundle,
    type RallarBlackBoxSharedTestArtifactBundleFiles,
    type RallarBlackBoxSharedTestParsedArtifactBundle
} from '../../../apps/rallar-black-box/src/shared-test-handoff-fixtures.ts';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const legacySharedTestRoot = resolve(
    repositoryRoot,
    'apps/rallar-black-box/src/legacy/runner/shared-test'
);
const fixtureRoot = resolve(
    repositoryRoot,
    'packages/shared-test/black-box-runner/fixtures/schema/v1/artifact-bundle'
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean; })
    .IS_REACT_ACT_ENVIRONMENT = true;

type SharedTestArtifactIndex = NonNullable<RallarBlackBoxSharedTestParsedArtifactBundle['views']['artifactIndex']>;

function fixtureFiles(
    includeIndex = true
): RallarBlackBoxSharedTestArtifactBundleFiles {
    const files: RallarBlackBoxSharedTestArtifactBundleFiles = {
        'report.json': fixture('report.json'),
        'events.jsonl': fixture('events.jsonl'),
        'failures.json': fixture('failures.json'),
        'metadata.json': fixture('metadata.json')
    };
    if (includeIndex) {
        files['artifact-index.json'] = fixture('artifact-index.json');
    }
    return files;
}

function fixture(fileName: string): string {
    return readFileSync(resolve(fixtureRoot, fileName), 'utf8');
}

function fixtureArtifactIndex(): SharedTestArtifactIndex {
    const parsed = parseRallarBlackBoxSharedTestArtifactBundle(fixtureFiles());
    if (!parsed.value?.views.artifactIndex) {
        throw new Error('Expected the v1 Shared Test fixture artifact index.');
    }
    return parsed.value.views.artifactIndex;
}

function artifactIndexWithSummaries(
    names: readonly string[]
): SharedTestArtifactIndex {
    const artifactIndex = fixtureArtifactIndex();
    return {
        ...artifactIndex,
        compaction: {
            compacted: true,
            repeatedSuccessSummaries: names.map((name, index) => ({
                name,
                transport: index % 2 === 0 ? 'RTC' : 'WS',
                action: 'send',
                connection: `connection-${index % 3}`,
                status: 'SUCCESS',
                count: 1,
                firstSequence: index + 1,
                lastSequence: index + 1
            }))
        },
        truncation: {
            ...artifactIndex.truncation,
            truncated: true,
            totalEvents: names.length + 10,
            emittedEvents: 10,
            omittedEvents: names.length
        }
    };
}

function repeatedSummaryRecords(
    artifactIndex: SharedTestArtifactIndex
): readonly Record<string, unknown>[] {
    const summaries = artifactIndex.compaction?.repeatedSuccessSummaries;
    if (!Array.isArray(summaries)) {
        throw new Error('Expected synthetic repeated-success summaries.');
    }
    return summaries as readonly Record<string, unknown>[];
}

function withRepeatedSummaryRecords(
    artifactIndex: SharedTestArtifactIndex,
    summaries: readonly Record<string, unknown>[]
): SharedTestArtifactIndex {
    return {
        ...artifactIndex,
        compaction: {
            ...artifactIndex.compaction,
            compacted: true,
            repeatedSuccessSummaries: summaries
        }
    };
}

function artifactIndexInvariantConflictCases(): readonly Readonly<{
    label: string;
    artifactIndex: SharedTestArtifactIndex;
}>[] {
    const withOmissions = artifactIndexWithSummaries(['trusted-summary']);
    const twoGroups = artifactIndexWithSummaries([
        'trusted-summary-a',
        'trusted-summary-b'
    ]);
    const trustedSummary = repeatedSummaryRecords(withOmissions)[0]!;
    const [firstGroup, secondGroup] = repeatedSummaryRecords(twoGroups);
    const withoutOmissions: SharedTestArtifactIndex = {
        ...withOmissions,
        compaction: { compacted: false, repeatedSuccessSummaries: [] },
        truncation: {
            ...withOmissions.truncation,
            truncated: false,
            totalEvents: 10,
            emittedEvents: 10,
            omittedEvents: 0
        }
    };
    return [
        {
            label: 'false truncation with omitted events',
            artifactIndex: {
                ...withOmissions,
                truncation: { ...withOmissions.truncation, truncated: false }
            }
        },
        {
            label: 'true truncation with zero omitted events',
            artifactIndex: {
                ...withoutOmissions,
                truncation: { ...withoutOmissions.truncation, truncated: true }
            }
        },
        {
            label: 'unequal total and partition counts',
            artifactIndex: {
                ...withOmissions,
                truncation: { ...withOmissions.truncation, totalEvents: 12 }
            }
        },
        {
            label: 'fractional counts despite an equal partition',
            artifactIndex: {
                ...withOmissions,
                truncation: {
                    ...withOmissions.truncation,
                    totalEvents: 10.5,
                    emittedEvents: 9.5,
                    omittedEvents: 1
                }
            }
        },
        {
            label: 'compaction and truncation flags disagree',
            artifactIndex: {
                ...withOmissions,
                compaction: { compacted: false, repeatedSuccessSummaries: [] }
            }
        },
        {
            label: 'summary count exceeds its inclusive sequence span',
            artifactIndex: withRepeatedSummaryRecords(withOmissions, [{
                ...trustedSummary,
                count: 2
            }])
        },
        {
            label: 'summary counts exceed all omitted events',
            artifactIndex: withRepeatedSummaryRecords(twoGroups, [{
                ...firstGroup,
                count: 2,
                firstSequence: 1,
                lastSequence: 2
            }, secondGroup!])
        },
        {
            label: 'duplicate producer composite groups',
            artifactIndex: withRepeatedSummaryRecords(twoGroups, [
                firstGroup!,
                {
                    ...secondGroup,
                    name: firstGroup!.name,
                    transport: firstGroup!.transport,
                    action: firstGroup!.action,
                    connection: firstGroup!.connection
                }
            ])
        },
        {
            label: 'summary sequence starts at zero',
            artifactIndex: withRepeatedSummaryRecords(withOmissions, [{
                ...trustedSummary,
                firstSequence: 0,
                lastSequence: 0
            }])
        },
        {
            label: 'summary sequence exceeds the indexed event total',
            artifactIndex: withRepeatedSummaryRecords(withOmissions, [{
                ...trustedSummary,
                firstSequence: 12,
                lastSequence: 12
            }])
        }
    ];
}

describe('legacy Shared Test artifact-index compaction', () => {
    it('keeps producer counts distinct from the loaded truncation marker', () => {
        const parsed = parseRallarBlackBoxSharedTestArtifactBundle(fixtureFiles());
        const artifactIndex = parsed.value?.views.artifactIndex;

        expect(parsed.ok).toBe(true);
        expect(parsed.value?.views.eventStream).toHaveLength(5);
        expect(artifactIndex).toBe(parsed.value?.artifactIndex);
        expect(artifactIndex).toBeDefined();

        const presentation = deriveSharedTestArtifactIndexPresentation(
            artifactIndex!
        );
        expect(presentation.truncation).toEqual({
            totalEvents: 7,
            emittedEvents: 4,
            omittedEvents: 3,
            truncated: true
        });
        expect(presentation.compaction).toMatchObject({
            status: 'compacted',
            summariesAvailable: true,
            summaryCount: 0,
            summaries: []
        });
    });

    it('rejects producer count and flag conflicts as one untrusted index', () => {
        for (const { label, artifactIndex } of artifactIndexInvariantConflictCases()) {
            expect(
                deriveSharedTestArtifactIndexPresentation(artifactIndex),
                label
            ).toEqual({
                status: 'inconsistent',
                truncation: {},
                compaction: {
                    status: 'index-inconsistent',
                    summariesAvailable: false,
                    summaries: []
                }
            });
        }
    });

    it('keeps delimiter-bearing producer tuples distinct by exact field identity', () => {
        const twoGroups = artifactIndexWithSummaries([
            'trusted-summary-a',
            'trusted-summary-b'
        ]);
        const [firstGroup, secondGroup] = repeatedSummaryRecords(twoGroups);
        const artifactIndex = withRepeatedSummaryRecords(twoGroups, [{
            ...firstGroup,
            name: 'name|transport',
            transport: 'action',
            action: 'connection',
            connection: 'tail'
        }, {
            ...secondGroup,
            name: 'name',
            transport: 'transport',
            action: 'action',
            connection: 'connection|tail'
        }]);

        expect(deriveSharedTestArtifactIndexPresentation(artifactIndex))
            .toMatchObject({
                status: 'coherent',
                compaction: {
                    status: 'compacted',
                    summaryCount: 2
                }
            });
    });

    it('traverses every compacted success summary in exact 24-row windows', () => {
        const names = Array.from(
            { length: 61 },
            (_, index) => `success-group-${String(index + 1).padStart(3, '0')}`
        );
        const presentation = deriveSharedTestArtifactIndexPresentation(
            artifactIndexWithSummaries(names)
        );
        const ranges: Array<readonly [number, number]> = [];
        const visited: Array<readonly [number, string | undefined]> = [];
        let startIndex = 0;

        while (true) {
            const window = deriveSharedTestCompactionSummaryWindow(
                presentation.compaction.summaries,
                startIndex
            );
            ranges.push([window.displayStart, window.displayEnd]);
            visited.push(...window.rows.map((row) => [row.sourceOrdinal, row.name] as const));
            expect(window.rows.length).toBeLessThanOrEqual(
                SHARED_TEST_COMPACTION_SUMMARY_WINDOW_SIZE
            );
            if (!window.canNext) {
                break;
            }
            startIndex = moveSharedTestCompactionSummaryWindow(window, 'next');
        }

        expect(ranges).toEqual([[1, 24], [25, 48], [49, 61]]);
        expect(visited).toEqual(names.map((name, index) => [index + 1, name]));
        expect(new Set(visited.map(([ordinal]) => ordinal)).size).toBe(61);
    });

    it('preserves duplicate and bidi identities by absolute source ordinal', () => {
        const bidiIdentity = '  success/group/\u202efull identity  ';
        const presentation = deriveSharedTestArtifactIndexPresentation(
            artifactIndexWithSummaries([
                'duplicate-success',
                'duplicate-success',
                bidiIdentity
            ])
        );

        expect(presentation.compaction.summaries.map((summary) => ({
            ordinal: summary.sourceOrdinal,
            name: summary.name
        }))).toEqual([
            { ordinal: 1, name: 'duplicate-success' },
            { ordinal: 2, name: 'duplicate-success' },
            { ordinal: 3, name: bidiIdentity }
        ]);
    });

    it('gates compaction groups on coherent producer metadata and records', () => {
        const artifactIndex = fixtureArtifactIndex();
        const validSummary = repeatedSummaryRecords(
            artifactIndexWithSummaries(['valid'])
        )[0]!;
        const presentation = (compaction: Record<string, unknown> | undefined) => {
            const noOmissions = compaction?.compacted === false;
            return deriveSharedTestArtifactIndexPresentation({
                ...artifactIndex,
                compaction,
                truncation: noOmissions
                    ? {
                        ...artifactIndex.truncation,
                        truncated: false,
                        totalEvents: 4,
                        emittedEvents: 4,
                        omittedEvents: 0
                    }
                    : artifactIndex.truncation
            }).compaction;
        };

        expect(presentation(undefined)).toEqual({
            status: 'metadata-unavailable',
            summariesAvailable: false,
            summaries: []
        });
        expect(presentation({ compacted: 'yes', repeatedSuccessSummaries: [] }))
            .toEqual({
                status: 'flag-invalid',
                summariesAvailable: false,
                summaries: []
            });
        expect(presentation({
            compacted: false,
            repeatedSuccessSummaries: [validSummary]
        })).toEqual({
            status: 'incoherent',
            summariesAvailable: false,
            summaries: []
        });
        expect(presentation({ compacted: true })).toEqual({
            status: 'summaries-unavailable',
            summariesAvailable: false,
            summaries: []
        });
        expect(presentation({
            compacted: true,
            repeatedSuccessSummaries: [{
                name: 'malformed',
                transport: 'RTC',
                action: 'send',
                status: 'SUCCESS',
                count: -1,
                firstSequence: 1,
                lastSequence: 2
            }]
        })).toEqual({
            status: 'summaries-invalid',
            summariesAvailable: false,
            summaries: []
        });
        expect(presentation({ compacted: false, repeatedSuccessSummaries: [] }))
            .toEqual({
                status: 'not-compacted',
                summariesAvailable: false,
                summaries: []
            });
        expect(presentation({ compacted: true, repeatedSuccessSummaries: [] }))
            .toEqual({
                status: 'compacted',
                summariesAvailable: true,
                summaryCount: 0,
                summaries: []
            });
    });

    it('preserves the valid no-index fallback', () => {
        const parsed = parseRallarBlackBoxSharedTestArtifactBundle(
            fixtureFiles(false)
        );

        expect(parsed.ok).toBe(true);
        expect(parsed.value?.views.artifactIndex).toBeUndefined();
        expect(parsed.value?.views.eventStream).toHaveLength(5);
    });
});

describe('SharedTestArtifactIndexPanel', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) {
            await act(async () => root?.unmount());
        }
        root = undefined;
        container.remove();
    });

    async function render(artifactIndex: SharedTestArtifactIndex | undefined) {
        if (!root) {
            root = createRoot(container);
        }
        await act(async () =>
            root?.render(
                artifactIndex
                    ? createElement(SharedTestArtifactIndexPanel, { artifactIndex })
                    : null
            )
        );
    }

    it('renders exact generic producer truth without distributed correlation', async () => {
        await render(fixtureArtifactIndex());

        expect(container.querySelector('[data-shared-test-artifact-index]'))
            .not.toBeNull();
        expect(container.textContent).toContain(
            'Generic black-box-runner artifact index'
        );
        expect(container.textContent).toContain(
            'not authoritative distributed-run identity'
        );
        expect(
            container.querySelector('[data-shared-test-index-total-events]')
                ?.textContent
        ).toBe('7');
        expect(
            container.querySelector('[data-shared-test-index-emitted-events]')
                ?.textContent
        ).toBe('4');
        expect(
            container.querySelector('[data-shared-test-index-omitted-events]')
                ?.textContent
        ).toBe('3');
        expect(container.textContent).toContain(
            '0 compacted success groups reported.'
        );
        expect(container.querySelectorAll('[data-compaction-summary-row]'))
            .toHaveLength(0);
    });

    it('does not invent zero when compacted summaries are unavailable', async () => {
        const artifactIndex = fixtureArtifactIndex();
        await render({
            ...artifactIndex,
            compaction: { compacted: true }
        });

        expect(
            container.querySelector('[data-shared-test-index-summary-count]')
                ?.textContent
        ).toBe('unknown');
        expect(container.textContent).toContain(
            'Compaction summaries unavailable.'
        );
        expect(container.textContent).not.toContain(
            '0 compacted success groups reported.'
        );
    });

    it('renders distinct untrusted compaction states without counts or rows', async () => {
        const artifactIndex = fixtureArtifactIndex();
        const validSummary = repeatedSummaryRecords(
            artifactIndexWithSummaries(['valid'])
        )[0]!;
        const cases = [
            [undefined, 'Compaction metadata unavailable.'],
            [{ compacted: 'yes' }, 'Compaction flag is invalid.'],
            [{ compacted: true }, 'Compaction summaries unavailable.'],
            [{
                compacted: false,
                repeatedSuccessSummaries: [validSummary]
            }, 'Compaction metadata is inconsistent.'],
            [{
                compacted: true,
                repeatedSuccessSummaries: [null]
            }, 'Compaction summaries are invalid.']
        ] as const;

        for (const [compaction, message] of cases) {
            const noOmissions = compaction?.compacted === false;
            await render({
                ...artifactIndex,
                compaction,
                truncation: noOmissions
                    ? {
                        ...artifactIndex.truncation,
                        truncated: false,
                        totalEvents: 4,
                        emittedEvents: 4,
                        omittedEvents: 0
                    }
                    : artifactIndex.truncation
            });
            expect(
                container.querySelector(
                    '[data-shared-test-index-summary-count]'
                )?.textContent
            ).toBe('unknown');
            expect(container.textContent).toContain(message);
            expect(container.textContent).not.toContain(
                '0 compacted success groups reported.'
            );
            expect(container.querySelectorAll('[data-compaction-summary-row]'))
                .toHaveLength(0);
        }
    });

    it('suppresses trusted truth for joint producer invariant conflicts', async () => {
        for (const { label, artifactIndex } of artifactIndexInvariantConflictCases()) {
            await render(artifactIndex);
            expect(
                container.querySelector('[data-shared-test-artifact-index] .pill')
                    ?.textContent,
                label
            ).toBe('unknown');
            for (
                const name of [
                    'total-events',
                    'emitted-events',
                    'omitted-events',
                    'summary-count'
                ]
            ) {
                expect(
                    container.querySelector(
                        `[data-shared-test-index-${name}]`
                    )?.textContent,
                    `${label}: ${name}`
                ).toBe('unknown');
            }
            expect(container.textContent, label).toContain(
                'Artifact-index metadata is inconsistent.'
            );
            expect(container.querySelectorAll('[data-compaction-summary-row]'))
                .toHaveLength(0);
            expect(container.querySelector('[data-shared-test-compaction-window]'))
                .toBeNull();
        }
    });

    it('windows duplicate summaries and reaches an exact bidi final identity', async () => {
        const finalIdentity = '  success/group/\u202efull identity  ';
        const names = [
            'duplicate-success',
            'duplicate-success',
            ...Array.from(
                { length: 58 },
                (_, index) => `success-group-${String(index + 3).padStart(3, '0')}`
            ),
            finalIdentity
        ];
        await render(artifactIndexWithSummaries(names));

        const rows = () => [...container.querySelectorAll<HTMLElement>(
            '[data-compaction-summary-row]'
        )];
        const buttons = () => [...container.querySelectorAll<HTMLButtonElement>(
            '[data-shared-test-compaction-window] button'
        )];
        expect(rows()).toHaveLength(24);
        expect(
            rows().slice(0, 2).map((row) => ({
                name: row.querySelector('[data-compaction-summary-name]')?.textContent,
                ordinal: row.dataset.compactionSummaryOrdinal
            }))
        ).toEqual([
            { name: 'duplicate-success', ordinal: '1' },
            { name: 'duplicate-success', ordinal: '2' }
        ]);
        expect(container.querySelector('[role="status"]')?.textContent).toBe(
            'Showing 1–24 of 61 compacted success groups.'
        );

        await act(async () => buttons()[1]?.click());
        await act(async () => buttons()[1]?.click());
        expect(rows()).toHaveLength(13);
        expect(container.querySelector('[role="status"]')?.textContent).toBe(
            'Showing 49–61 of 61 compacted success groups.'
        );
        const finalName = rows().at(-1)?.querySelector<HTMLElement>(
            '[data-compaction-summary-name]'
        );
        expect(finalName?.textContent).toBe(finalIdentity);
        expect(finalName?.tagName).toBe('BDI');
        expect(finalName?.getAttribute('dir')).toBe('ltr');
    });

    it('recovers boundary-button focus to the persistent range status', async () => {
        await render(artifactIndexWithSummaries(Array.from(
            { length: 61 },
            (_, index) => `success-${index + 1}`
        )));
        const controls = () => [...container.querySelectorAll<HTMLButtonElement>(
            '[data-shared-test-compaction-window] button'
        )];
        const range = () =>
            container.querySelector<HTMLElement>(
                '[data-shared-test-compaction-range]'
            );

        controls()[1]!.focus();
        await act(async () => controls()[1]!.click());
        controls()[1]!.focus();
        await act(async () => controls()[1]!.click());
        expect(controls()[1]!.disabled).toBe(true);
        expect(document.activeElement).toBe(range());

        controls()[0]!.focus();
        await act(async () => controls()[0]!.click());
        controls()[0]!.focus();
        await act(async () => controls()[0]!.click());
        expect(controls()[0]!.disabled).toBe(true);
        expect(document.activeElement).toBe(range());
    });

    it('resets synchronously for a new parsed index and unmounts when absent', async () => {
        const names = Array.from(
            { length: 61 },
            (_, index) => `old-success-${index + 1}`
        );
        await render(artifactIndexWithSummaries(names));
        const next = container.querySelectorAll<HTMLButtonElement>(
            '[data-shared-test-compaction-window] button'
        )[1];
        await act(async () => next?.click());
        expect(container.querySelector('[role="status"]')?.textContent).toContain(
            'Showing 25–48'
        );

        const newNames = Array.from(
            { length: 70 },
            (_, index) => `new-success-${index + 1}`
        );
        await render(artifactIndexWithSummaries(newNames));
        expect(container.querySelector('[role="status"]')?.textContent).toBe(
            'Showing 1–24 of 70 compacted success groups.'
        );
        expect(
            container.querySelector('[data-compaction-summary-name]')
                ?.textContent
        ).toBe('new-success-1');

        await render(undefined);
        expect(container.querySelector('[data-shared-test-artifact-index]'))
            .toBeNull();
    });

    it('omits window controls at or below the row budget', async () => {
        await render(artifactIndexWithSummaries(['one', 'two']));

        expect(container.querySelectorAll('[data-compaction-summary-row]'))
            .toHaveLength(2);
        expect(container.querySelector('[data-shared-test-compaction-window]'))
            .toBeNull();
    });

    it('scopes summary-list IDs to each simultaneously mounted panel', async () => {
        const artifactIndex = artifactIndexWithSummaries(
            Array.from({ length: 25 }, (_, index) => `summary-${index + 1}`)
        );
        if (!root) {
            root = createRoot(container);
        }
        await act(async () =>
            root?.render(
                createElement(
                    'div',
                    null,
                    createElement(SharedTestArtifactIndexPanel, { artifactIndex }),
                    createElement(SharedTestArtifactIndexPanel, { artifactIndex })
                )
            )
        );

        const panels = [...container.querySelectorAll<HTMLElement>(
            '[data-shared-test-artifact-index]'
        )];
        const lists = panels.map((panel) => panel.querySelector<HTMLOListElement>('ol'));
        expect(panels).toHaveLength(2);
        expect(lists.every(Boolean)).toBe(true);
        expect(new Set(lists.map((list) => list?.id)).size).toBe(2);
        for (const [index, panel] of panels.entries()) {
            const list = lists[index]!;
            const controls = [...panel.querySelectorAll('[aria-controls]')];
            expect(controls).toHaveLength(2);
            expect(controls.every((control) => control.getAttribute('aria-controls') === list.id)).toBe(true);
            expect(list.closest('[data-shared-test-artifact-index]')).toBe(panel);
        }
    });
});
