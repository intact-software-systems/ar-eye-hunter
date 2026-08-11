// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createExplicitWindowState,
    deriveExplicitWindowModel,
    moveExplicitWindow,
    revealExplicitWindowIndex,
} from '../../../apps/rallar-black-box/src/recipe-console/ui/explicit-window-model.ts';
import {
    useExplicitWindow,
    useExplicitWindowFocusRecovery,
} from '../../../apps/rallar-black-box/src/recipe-console/ui/use-explicit-window.ts';
import {
    ExplicitWindowControls,
} from '../../../apps/rallar-black-box/src/recipe-console/ui/ExplicitWindowControls.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

describe('Recipe Console explicit window model', () => {
    it('resets synchronously to the exact first range when its fingerprint changes', () => {
        const model = deriveExplicitWindowModel({
            fingerprint: 'artifact-b:query-b',
            total: 150,
            windowSize: 64,
        }, {
            fingerprint: 'artifact-a:query-a',
            startIndex: 64,
        });

        expect(model).toEqual({
            fingerprint: 'artifact-b:query-b',
            total: 150,
            windowSize: 64,
            startIndex: 0,
            endIndexExclusive: 64,
            displayStart: 1,
            displayEnd: 64,
            canPrevious: false,
            canNext: true,
        });
    });

    it('traverses exact non-overlapping ranges and clamps a shrunken total', () => {
        const input = {
            fingerprint: 'history:filters-a',
            total: 150,
            windowSize: 64,
        } as const;
        let state = createExplicitWindowState(input.fingerprint);
        const ranges: Array<readonly [number, number]> = [];

        while (true) {
            const model = deriveExplicitWindowModel(input, state);
            ranges.push([model.startIndex, model.endIndexExclusive]);
            if (!model.canNext) break;
            state = moveExplicitWindow(model, 'next');
        }

        expect(ranges).toEqual([[0, 64], [64, 128], [128, 150]]);
        expect(deriveExplicitWindowModel({
            ...input,
            total: 90,
        }, state)).toMatchObject({
            startIndex: 64,
            endIndexExclusive: 90,
            displayStart: 65,
            displayEnd: 90,
            canPrevious: true,
            canNext: false,
        });
    });

    it('normalizes empty and non-finite bounds to a finite empty range', () => {
        expect(deriveExplicitWindowModel({
            fingerprint: 'empty',
            total: Number.NaN,
            windowSize: Number.POSITIVE_INFINITY,
        }, {
            fingerprint: 'empty',
            startIndex: Number.POSITIVE_INFINITY,
        })).toEqual({
            fingerprint: 'empty',
            total: 0,
            windowSize: 1,
            startIndex: 0,
            endIndexExclusive: 0,
            displayStart: 0,
            displayEnd: 0,
            canPrevious: false,
            canNext: false,
        });
    });

    it('reveals a high ordinal on its exact containing page and clamps shrink', () => {
        const revision = {};
        const model = deriveExplicitWindowModel({
            fingerprint: 'selector:runs',
            revision,
            total: 250,
            windowSize: 100,
        }, createExplicitWindowState('selector:runs', revision));

        const revealed = revealExplicitWindowIndex(model, 217);
        expect(revealed).toEqual({
            fingerprint: 'selector:runs',
            revision,
            startIndex: 200,
        });
        expect(deriveExplicitWindowModel({
            fingerprint: 'selector:runs',
            revision,
            total: 250,
            windowSize: 100,
        }, revealed)).toMatchObject({
            startIndex: 200,
            endIndexExclusive: 250,
            displayStart: 201,
            displayEnd: 250,
        });
        expect(deriveExplicitWindowModel({
            fingerprint: 'selector:runs',
            revision,
            total: 140,
            windowSize: 100,
        }, revealed)).toMatchObject({
            startIndex: 100,
            endIndexExclusive: 140,
        });
        expect(revealExplicitWindowIndex(deriveExplicitWindowModel({
            fingerprint: 'selector:empty',
            revision,
            total: 0,
            windowSize: 100,
        }, createExplicitWindowState('selector:empty', revision)), 217))
            .toMatchObject({ startIndex: 0 });
    });

    it('resets the range when an exact source revision changes', () => {
        const firstRevision = {};
        const nextRevision = {};
        const previous = revealExplicitWindowIndex(deriveExplicitWindowModel({
            fingerprint: 'selector:runs',
            revision: firstRevision,
            total: 250,
            windowSize: 100,
        }, createExplicitWindowState('selector:runs', firstRevision)), 217);

        expect(deriveExplicitWindowModel({
            fingerprint: 'selector:runs',
            revision: nextRevision,
            total: 250,
            windowSize: 100,
        }, previous)).toMatchObject({
            revision: nextRevision,
            startIndex: 0,
            endIndexExclusive: 100,
        });
    });
});

describe('useExplicitWindow', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root?.unmount());
        root = undefined;
        container.remove();
    });

    function Harness({
        fingerprint,
        revealIndex,
        revision,
        total,
    }: Readonly<{
        fingerprint: string;
        revealIndex?: number;
        revision?: object;
        total: number;
    }>) {
        const window = useExplicitWindow({
            fingerprint,
            revision,
            total,
            windowSize: 64,
        });
        return createElement('div', {},
            createElement('output', {
                'data-start': window.model.startIndex,
                'data-end': window.model.endIndexExclusive,
            }),
            createElement('button', {
                onClick: window.next,
                type: 'button',
            }, 'Next'),
            createElement('button', {
                onClick: () => window.revealIndex(revealIndex ?? 0),
                type: 'button',
            }, 'Reveal'),
        );
    }

    async function render(fingerprint: string, total: number) {
        if (!root) root = createRoot(container);
        await act(async () => root?.render(createElement(Harness, {
            fingerprint,
            total,
        })));
    }

    it('owns local movement while deriving a new fingerprint and shrink immediately',
        async () => {
            await render('history:a', 150);
            const next = container.querySelector<HTMLButtonElement>('button');
            await act(async () => next?.click());
            expect(container.querySelector('output')?.dataset).toMatchObject({
                start: '64',
                end: '128',
            });

            await render('history:b', 150);
            expect(container.querySelector('output')?.dataset).toMatchObject({
                start: '0',
                end: '64',
            });

            await render('history:a', 150);
            expect(container.querySelector('output')?.dataset).toMatchObject({
                start: '0',
                end: '64',
            });

            await act(async () => next?.click());
            await render('history:a', 30);
            expect(container.querySelector('output')?.dataset).toMatchObject({
                start: '0',
                end: '30',
            });

            await render('history:a', 150);
            expect(container.querySelector('output')?.dataset).toMatchObject({
                start: '0',
                end: '64',
            });
        });

    it('reveals by index and resets synchronously for an exact revision', async () => {
        const firstRevision = {};
        const nextRevision = {};
        if (!root) root = createRoot(container);
        await act(async () => root?.render(createElement(Harness, {
            fingerprint: 'selector:a',
            revealIndex: 149,
            revision: firstRevision,
            total: 250,
        })));
        const reveal = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Reveal');
        await act(async () => reveal?.click());
        expect(container.querySelector('output')?.dataset).toMatchObject({
            start: '128',
            end: '192',
        });

        await act(async () => root?.render(createElement(Harness, {
            fingerprint: 'selector:a',
            revealIndex: 149,
            revision: nextRevision,
            total: 250,
        })));
        expect(container.querySelector('output')?.dataset).toMatchObject({
            start: '0',
            end: '64',
        });
    });
});

describe('ExplicitWindowControls', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root?.unmount());
        root = undefined;
        container.remove();
    });

    async function renderControls({
        startIndex = 64,
        pending = false,
        onPrevious = () => undefined,
        onNext = () => undefined,
    }: Readonly<{
        startIndex?: number;
        pending?: boolean;
        onPrevious?: () => void;
        onNext?: () => void;
    }> = {}) {
        const model = deriveExplicitWindowModel({
            fingerprint: 'artifact:query',
            total: 150,
            windowSize: 64,
        }, { fingerprint: 'artifact:query', startIndex });
        root = createRoot(container);
        await act(async () => root?.render(createElement(
            ExplicitWindowControls,
            {
                contentId: 'artifact-evidence-results',
                itemLabel: 'retained matches',
                label: 'Evidence results',
                model,
                onNext,
                onPrevious,
                pending,
            },
        )));
    }

    it('presents exact live range and native boundary controls', async () => {
        let previousCalls = 0;
        let nextCalls = 0;
        await renderControls({
            onPrevious: () => previousCalls += 1,
            onNext: () => nextCalls += 1,
        });

        const group = container.querySelector('[role="group"]');
        const status = container.querySelector<HTMLElement>('[role="status"]');
        const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
        expect(group?.getAttribute('aria-label')).toBe('Evidence results window');
        expect(group?.getAttribute('aria-busy')).toBe('false');
        expect(status?.textContent).toBe(
            'Showing 65–128 of 150 retained matches.',
        );
        expect(status?.getAttribute('aria-live')).toBe('polite');
        expect(status?.getAttribute('aria-atomic')).toBe('true');
        expect(status?.tabIndex).toBe(-1);
        expect(buttons.map(button => ({
            controls: button.getAttribute('aria-controls'),
            direction: button.dataset.explicitWindowDirection,
            disabled: button.disabled,
            text: button.textContent,
            type: button.type,
        }))).toEqual([
            {
                controls: 'artifact-evidence-results',
                direction: 'previous',
                disabled: false,
                text: 'Previous',
                type: 'button',
            },
            {
                controls: 'artifact-evidence-results',
                direction: 'next',
                disabled: false,
                text: 'Next',
                type: 'button',
            },
        ]);
        await act(async () => buttons[0]?.click());
        await act(async () => buttons[1]?.click());
        expect({ previousCalls, nextCalls }).toEqual({
            previousCalls: 1,
            nextCalls: 1,
        });
    });

    it('keeps focused controls mounted while pending and blocks repeat requests',
        async () => {
            let previousCalls = 0;
            let nextCalls = 0;
            await renderControls({
                pending: true,
                onPrevious: () => previousCalls += 1,
                onNext: () => nextCalls += 1,
            });

            const group = container.querySelector('[role="group"]');
            const status = container.querySelector('[role="status"]');
            const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
            expect(group?.getAttribute('aria-busy')).toBe('true');
            expect(status?.textContent).toBe(
                'Showing 65–128 of 150 retained matches. Updating…',
            );
            expect(buttons.every(button => !button.disabled)).toBe(true);
            expect(buttons.every(button =>
                button.getAttribute('aria-disabled') === 'true'
            )).toBe(true);
            buttons[1]?.focus();
            await act(async () => buttons[0]?.click());
            await act(async () => buttons[1]?.click());
            expect(document.activeElement).toBe(buttons[1]);
            expect({ previousCalls, nextCalls }).toEqual({
                previousCalls: 0,
                nextCalls: 0,
            });
        });

    it('uses native disabled state at the first boundary', async () => {
        await renderControls({ startIndex: 0 });
        const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
        expect(buttons[0]?.disabled).toBe(true);
        expect(buttons[1]?.disabled).toBe(false);
    });

    it('announces an explicit unknown empty state without inventing zero matches',
        async () => {
            const model = deriveExplicitWindowModel({
                fingerprint: 'artifact:query-pending',
                total: 0,
                windowSize: 64,
            }, createExplicitWindowState('artifact:query-pending'));
            root = createRoot(container);
            await act(async () => root?.render(createElement(
                ExplicitWindowControls,
                {
                    contentId: 'artifact-evidence-results',
                    emptyLabel: 'Current query range is pending.',
                    label: 'Evidence results',
                    model,
                    onNext: vi.fn(),
                    onPrevious: vi.fn(),
                    pending: true,
                },
            )));

            expect(container.querySelector('[role="status"]')?.textContent)
                .toBe('Current query range is pending. Updating…');
            expect(container.querySelector('[role="status"]')?.textContent)
                .not.toContain('No items');
        });

    });

describe('explicit window focus recovery', () => {
    let container: HTMLDivElement;
    let root: Root | undefined;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
    });

    afterEach(async () => {
        if (root) await act(async () => root?.unmount());
        root = undefined;
        container.remove();
    });

    function FocusHarness({
        fingerprint,
        total,
    }: Readonly<{ fingerprint: string; total: number }>) {
        const window = useExplicitWindow({ fingerprint, total, windowSize: 64 });
        const focus = useExplicitWindowFocusRecovery(window.model);
        const rows = Array.from({
            length: window.model.endIndexExclusive - window.model.startIndex,
        }, (_, offset) => window.model.startIndex + offset);
        return createElement('div', focus.contentFocusProps,
            createElement(ExplicitWindowControls, {
                contentId: 'focus-results',
                focusFallbackRef: focus.fallbackFocusRef,
                label: 'Focus results',
                model: window.model,
                onNext: window.next,
                onPrevious: window.previous,
            }),
            createElement('ol', {
                id: 'focus-results',
            }, rows.map(row => createElement('li', { key: row },
                createElement('button', {
                    'data-row': row,
                    type: 'button',
                }, `Row ${row + 1}`),
            ))),
        );
    }

    async function render(fingerprint: string, total: number) {
        if (!root) root = createRoot(container);
        await act(async () => root?.render(createElement(FocusHarness, {
            fingerprint,
            total,
        })));
    }

    it('preserves a retained row and focuses the range when that row unmounts',
        async () => {
            await render('artifact:a', 150);
            const next = [...container.querySelectorAll<HTMLButtonElement>('button')]
                .find(button => button.textContent === 'Next');
            await act(async () => next?.click());
            const retained = container.querySelector<HTMLButtonElement>(
                '[data-row="69"]',
            );
            retained?.focus();
            expect(document.activeElement).toBe(retained);

            await render('artifact:a', 90);
            expect(document.activeElement).toBe(retained);

            await render('artifact:b', 90);
            const status = container.querySelector<HTMLElement>('[role="status"]');
            expect(document.activeElement).toBe(status);
            expect(status?.textContent).toBe('Showing 1–64 of 90 items.');
        });

    it('leaves focus on a range button that initiated navigation', async () => {
        await render('artifact:a', 150);
        const next = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Next');
        next?.focus();
        await act(async () => next?.click());
        expect(document.activeElement).toBe(next);
        expect(container.querySelector('[role="status"]')?.textContent)
            .toBe('Showing 65–128 of 150 items.');
    });

    it('does not recover a pending boundary action that navigation rejects',
        async () => {
            function PendingBoundary() {
                const model = deriveExplicitWindowModel({
                    fingerprint: 'pending-boundary', total: 128, windowSize: 64,
                }, createExplicitWindowState('pending-boundary'));
                const focus = useExplicitWindowFocusRecovery(model);
                return createElement('div', focus.contentFocusProps,
                    createElement(ExplicitWindowControls, {
                        contentId: 'pending-results',
                        label: 'Pending results',
                        model,
                        onNext: vi.fn(),
                        onPrevious: vi.fn(),
                        pending: true,
                    }),
                    createElement('span', {
                        'data-pending-fallback': true,
                        ref: focus.fallbackFocusRef,
                        tabIndex: -1,
                    }),
                );
            }
            if (!root) root = createRoot(container);
            await act(async () => root?.render(createElement(PendingBoundary)));
            const next = [...container.querySelectorAll<HTMLButtonElement>('button')]
                .find(button => button.textContent === 'Next');
            next?.focus();
            await act(async () => next?.click());
            expect(document.activeElement).toBe(next);
            expect(container.querySelector('[data-pending-fallback]'))
                .not.toBe(document.activeElement);
        });

    it('does not recover stale row focus after focus left the content', async () => {
        await render('artifact:a', 150);
        const next = [...container.querySelectorAll<HTMLButtonElement>('button')]
            .find(button => button.textContent === 'Next');
        await act(async () => next?.click());
        const row = container.querySelector<HTMLButtonElement>('[data-row="69"]');
        row?.focus();
        row?.blur();
        const focusAfterBlur = document.activeElement;
        expect(focusAfterBlur).not.toBe(row);

        await render('artifact:b', 90);
        expect(document.activeElement).toBe(focusAfterBlur);
        expect(document.activeElement).not.toBe(
            container.querySelector('[role="status"]'),
        );
    });

    it('does not recover an unavailable row after focus legitimately moved outside',
        async () => {
            await render('artifact:a', 150);
            const row = container.querySelector<HTMLButtonElement>('[data-row="0"]');
            const outside = document.createElement('button');
            outside.type = 'button';
            document.body.append(outside);
            row?.focus();
            if (!row) throw new Error('Expected focused row.');
            row.disabled = true;
            row.dispatchEvent(new FocusEvent('focusout', {
                bubbles: true,
                relatedTarget: outside,
            }));
            outside.focus();
            expect(document.activeElement).toBe(outside);

            await render('artifact:a', 150);

            expect(document.activeElement).toBe(outside);
            outside.remove();
        });
});
