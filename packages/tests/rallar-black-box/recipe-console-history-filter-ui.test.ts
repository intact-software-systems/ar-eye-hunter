// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryFilters } from
    '../../../apps/rallar-black-box/src/recipe-console/history/HistoryFilters.tsx';
import { HistorySavedFilters } from
    '../../../apps/rallar-black-box/src/recipe-console/history/HistorySavedFilters.tsx';
import type { HistoryFilterPreset } from
    '../../../apps/rallar-black-box/src/recipe-console/history/history-filter-contract.ts';
import type { HistoryFilterPresetController } from
    '../../../apps/rallar-black-box/src/recipe-console/history/use-history-filter-presets.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'tune',
};

describe('Recipe Console History filter presentation', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
    });

    it('keeps edits transient and applies one full eight-field replacement patch', async () => {
        const onApply = vi.fn();
        const from = Date.UTC(2026, 6, 12, 8, 30, 45, 125);
        const to = Date.UTC(2026, 6, 12, 9, 45, 10, 250);
        await renderFilters({
            urlState: {
                ...BASE_STATE,
                historyQuery: 'committed query',
                historyGroup: 'committed/group',
                historyRecipeId: 'committed-recipe',
                historyProfile: 'smoke',
                failureCategory: 'readiness',
                status: 'failed',
                from,
                to,
            },
            onApply,
        });

        expect(labelled<HTMLInputElement>('Query').maxLength).toBe(512);
        expect(labelled<HTMLInputElement>('Group').maxLength).toBe(256);
        expect(labelled<HTMLInputElement>('Recipe').maxLength).toBe(256);
        expect(labelled<HTMLInputElement>('Profile').maxLength).toBe(256);
        await setControlValue(labelled<HTMLInputElement>('Query'), '  draft query  ');
        await setControlValue(labelled<HTMLInputElement>('Group'), 'draft/group');
        await setControlValue(labelled<HTMLInputElement>('Recipe'), 'draft-recipe');
        await setControlValue(labelled<HTMLInputElement>('Profile'), 'load');
        await setControlValue(labelled<HTMLSelectElement>('Failure category'), 'command');
        await setControlValue(labelled<HTMLSelectElement>('Run status'), 'passed');

        expect(onApply).not.toHaveBeenCalled();
        await submit(labelled<HTMLInputElement>('Query').form);

        expect(onApply).toHaveBeenCalledTimes(1);
        expect(onApply).toHaveBeenCalledWith({
            historyQuery: 'draft query',
            historyGroup: 'draft/group',
            historyRecipeId: 'draft-recipe',
            historyProfile: 'load',
            failureCategory: 'command',
            status: 'passed',
            from,
            to,
        });
    });

    it('resets the visible draft and emits one full empty replacement patch', async () => {
        const onReset = vi.fn();
        await renderFilters({
            urlState: { ...BASE_STATE, historyQuery: 'committed' },
            onReset,
        });
        await setControlValue(labelled<HTMLInputElement>('Query'), 'unsaved');

        await click(button('Reset'));

        expect(labelled<HTMLInputElement>('Query').value).toBe('');
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onReset).toHaveBeenCalledWith({
            historyQuery: undefined,
            historyGroup: undefined,
            historyRecipeId: undefined,
            historyProfile: undefined,
            failureCategory: undefined,
            status: undefined,
            from: undefined,
            to: undefined,
        });
    });

    it('uses resetRevision to discard an unsaved draft when the URL values are equal', async () => {
        const props = {
            urlState: { ...BASE_STATE, historyQuery: 'same committed query' },
            resetRevision: 0,
            onApply: vi.fn(),
            onReset: vi.fn(),
        };
        await act(async () => root.render(createElement(HistoryFilters, props)));
        await setControlValue(labelled<HTMLInputElement>('Query'), 'unsaved query');

        await act(async () => root.render(createElement(HistoryFilters, {
            ...props,
            resetRevision: 1,
        })));

        expect(labelled<HTMLInputElement>('Query').value).toBe('same committed query');
    });

    it('formats and parses datetime-local controls as deterministic UTC milliseconds', async () => {
        const onApply = vi.fn();
        const from = Date.UTC(2026, 6, 12, 8, 30, 45, 125);
        await renderFilters({
            urlState: { ...BASE_STATE, from },
            onApply,
        });
        const fromInput = labelled<HTMLInputElement>('From (UTC)');
        const toInput = labelled<HTMLInputElement>('To (UTC)');

        expect(fromInput.type).toBe('datetime-local');
        expect(fromInput.step).toBe('0.001');
        expect(fromInput.value).toBe('2026-07-12T08:30:45.125');
        await setControlValue(toInput, '2026-12-01T04:05:06.007');
        await click(button('Apply filters'));

        expect(onApply.mock.calls[0]?.[0]).toMatchObject({
            from,
            to: Date.UTC(2026, 11, 1, 4, 5, 6, 7),
        });
    });

    it('uses visible labels and a semantic form for keyboard submission', async () => {
        const onApply = vi.fn();
        await renderFilters({ urlState: BASE_STATE, onApply });

        for (const text of [
            'Query',
            'Group',
            'Recipe',
            'Profile',
            'Failure category',
            'Run status',
            'From (UTC)',
            'To (UTC)',
        ]) {
            expect(labelled<HTMLInputElement | HTMLSelectElement>(text)).toBeTruthy();
        }
        const query = labelled<HTMLInputElement>('Query');
        expect(query.form?.tagName).toBe('FORM');
        expect(button('Apply filters').type).toBe('submit');
        await setControlValue(query, 'entered by keyboard');
        await submit(query.form);

        expect(onApply).toHaveBeenCalledTimes(1);
        expect(onApply.mock.calls[0]?.[0]).toMatchObject({
            historyQuery: 'entered by keyboard',
        });
    });

    it('saves a bounded name and applies or deletes the exact ruled-list preset', async () => {
        const savedPreset: HistoryFilterPreset = {
            name: 'Failed readiness',
            filters: {
                historyQuery: 'ack',
                failureCategory: 'readiness',
                status: 'failed',
            },
        };
        const save = vi.fn();
        const remove = vi.fn();
        const onApply = vi.fn();
        const controller: HistoryFilterPresetController = {
            presets: [savedPreset],
            status: 'ready',
            save,
            remove,
        };
        await act(async () => root.render(createElement(HistorySavedFilters, {
            controller,
            onApply,
        })));

        const name = labelled<HTMLInputElement>('Preset name');
        expect(name.maxLength).toBe(64);
        expect(container.querySelector('details > summary')?.textContent)
            .toContain('Saved filters (1)');
        expect(container.querySelector('details ul')).toBeTruthy();
        expect(container.textContent).toContain('Saved filters ready');
        await setControlValue(name, 'My current view');
        await submit(name.form);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save).toHaveBeenCalledWith('My current view');

        await click(button('Apply'));
        expect(onApply).toHaveBeenCalledTimes(1);
        expect(onApply.mock.calls[0]?.[0]).toBe(savedPreset);
        await click(button('Delete'));
        expect(remove).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith('Failed readiness');
    });

    it.each([
        ['ready', 'Saved filters ready'],
        ['invalid', 'Saved filters need attention'],
        ['unsupported', 'Saved filters use a newer format'],
        ['unavailable', 'Saved filters unavailable'],
        ['write-failed', 'Could not save filters'],
    ] as const)('shows the %s controller status visibly', async (status, message) => {
        const controller: HistoryFilterPresetController = {
            presets: [],
            status,
            save: vi.fn(),
            remove: vi.fn(),
        };
        await act(async () => root.render(createElement(HistorySavedFilters, {
            controller,
            onApply: vi.fn(),
        })));

        expect(container.querySelector('[role="status"]')?.textContent).toContain(message);
    });

    it('keeps both presentations flat, compact, and responsive at 4/2/1 columns', () => {
        const historyDirectory = resolve(
            process.cwd(),
            'apps/rallar-black-box/src/recipe-console/history',
        );
        const filtersCss = readFileSync(
            resolve(historyDirectory, 'HistoryFilters.module.css'),
            'utf8',
        );
        const savedCss = readFileSync(
            resolve(historyDirectory, 'HistorySavedFilters.module.css'),
            'utf8',
        );

        expect(filtersCss).toContain('repeat(4, minmax(0, 1fr))');
        expect(filtersCss).toContain('repeat(2, minmax(0, 1fr))');
        expect(filtersCss).toContain('grid-template-columns: minmax(0, 1fr)');
        expect(filtersCss).toContain('min-height: 44px');
        expect(`${filtersCss}\n${savedCss}`).not.toMatch(/box-shadow|border-radius:\s*(?:[7-9]|\d{2,})px/);
    });

    async function renderFilters(input: Readonly<{
        urlState: RecipeConsoleUrlState;
        onApply?: (patch: Partial<RecipeConsoleUrlState>) => void;
        onReset?: (patch: Partial<RecipeConsoleUrlState>) => void;
    }>): Promise<void> {
        await act(async () => root.render(createElement(HistoryFilters, {
            onApply: input.onApply ?? vi.fn(),
            onReset: input.onReset ?? vi.fn(),
            resetRevision: 0,
            urlState: input.urlState,
        })));
    }

    function labelled<T extends HTMLInputElement | HTMLSelectElement>(text: string): T {
        const label = Array.from(container.querySelectorAll('label')).find(
            candidate => candidate.querySelector('span')?.textContent === text,
        );
        const control = label?.querySelector('input, select');
        if (!control) throw new Error(`Missing control labelled ${text}`);
        return control as T;
    }

    function button(text: string): HTMLButtonElement {
        const match = Array.from(container.querySelectorAll('button')).find(
            candidate => candidate.textContent?.trim() === text,
        );
        if (!match) throw new Error(`Missing button ${text}`);
        return match;
    }
});

async function setControlValue(
    control: HTMLInputElement | HTMLSelectElement,
    value: string,
): Promise<void> {
    await act(async () => {
        const prototype = control instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (!setter) throw new Error('Expected native control value setter');
        setter.call(control, value);
        control.dispatchEvent(new Event(
            control instanceof HTMLSelectElement ? 'change' : 'input',
            { bubbles: true },
        ));
    });
}

async function submit(form: HTMLFormElement | null): Promise<void> {
    if (!form) throw new Error('Expected semantic form');
    await act(async () => form.dispatchEvent(new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
    })));
}

async function click(button: HTMLButtonElement): Promise<void> {
    await act(async () => button.click());
}
