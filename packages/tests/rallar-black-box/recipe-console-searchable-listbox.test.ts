// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    SEARCHABLE_LISTBOX_WINDOW_SIZE,
    type SearchableListboxOption,
} from '../../../apps/rallar-black-box/src/recipe-console/ui/searchable-listbox-model.ts';
import { SearchableWindowedListbox } from
    '../../../apps/rallar-black-box/src/recipe-console/ui/SearchableWindowedListbox.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const repoRoot = resolve(import.meta.dirname, '../../..');

describe('SearchableWindowedListbox', () => {
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

    async function renderSelector(input: Readonly<{
        contextKey?: string;
        disabled?: boolean;
        onSelect?: (option: SearchableListboxOption) => void;
        options: readonly SearchableListboxOption[];
        revision?: object;
        selectedKey?: string;
    }>) {
        if (!root) root = createRoot(container);
        await act(async () => root?.render(createElement(Fragment, {},
            createElement(SearchableWindowedListbox, {
                contextKey: input.contextKey ?? 'runs:a',
                disabled: input.disabled,
                id: 'run-source',
                label: 'Run source',
                onSelect: input.onSelect ?? (() => undefined),
                options: input.options,
                placeholder: 'Choose a run',
                revision: input.revision,
                selectedKey: input.selectedKey,
            }),
            createElement('button', {
                'data-test-outside-target': true,
                type: 'button',
            }, 'Outside target'),
        )));
    }

    it('mounts no closed options, reveals a high selected key, and traverses exact pages',
        async () => {
            const options = fixtureOptions(250);
            await renderSelector({ options, selectedKey: 'key-217' });
            expect(SEARCHABLE_LISTBOX_WINDOW_SIZE).toBe(100);
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);

            await clickTrigger(container);
            expect(rangeText(container)).toBe('Showing 201–250 of 250 options.');
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(50);
            expect(container.querySelector('[role="option"][aria-selected="true"]')
                ?.getAttribute('data-option-key')).toBe('key-217');
            expect(container.querySelector('[data-searchable-listbox-outside]')?.textContent)
                .toBe('200 options outside this window and browseable.');

            const reverse = await traverse(container, 'Previous');
            expect(reverse).toEqual(options.map(option => option.key));
            const forward = await traverse(container, 'Next');
            expect(forward).toEqual(options.map(option => option.key));
            expect(new Set(forward).size).toBe(250);

            const nextRevision = {};
            await renderSelector({
                options,
                revision: nextRevision,
                selectedKey: 'key-149',
            });
            expect(rangeText(container)).toBe('Showing 101–200 of 250 options.');
            expect(container.querySelector('[role="option"][aria-selected="true"]')
                ?.getAttribute('data-option-key')).toBe('key-149');
        });

    it('resets every search to its first exact result window without committing',
        async () => {
            const onSelect = vi.fn();
            const options = fixtureOptions(203).map((option, index) => ({
                ...option,
                searchText: index < 101
                    ? `common ${index === 0 ? 'first-needle' : index === 50
                        ? 'middle-needle'
                        : index === 100 ? 'last-needle' : ''}`
                    : option.searchText,
            }));
            await renderSelector({ onSelect, options });
            await clickTrigger(container);

            await setSearch(container, 'common');
            expect(rangeText(container)).toBe('Showing 1–100 of 101 options.');
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(100);
            expect(onSelect).not.toHaveBeenCalled();
            await clickWindow(container, 'Next');
            expect(rangeText(container)).toBe('Showing 101–101 of 101 options.');
            expect(onSelect).not.toHaveBeenCalled();

            for (const [query, key] of [
                ['first-needle', 'key-0'],
                ['middle-needle', 'key-50'],
                ['last-needle', 'key-100'],
            ] as const) {
                await setSearch(container, query);
                expect(rangeText(container)).toBe('Showing 1–1 of 1 options.');
                expect(container.querySelector('[role="option"]')
                    ?.getAttribute('data-option-key')).toBe(key);
            }

            await setSearch(container, 'missing-needle');
            expect(rangeText(container)).toBe('No options match this search.');
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
            expect(container.querySelector('[data-searchable-listbox-empty]')?.textContent)
                .toBe('No options match this search.');
            expect(onSelect).not.toHaveBeenCalled();
        });

    it('keeps one stable polite atomic range status across filtered count bands',
        async () => {
            await renderSelector({ options: fixtureOptions(250) });
            await clickTrigger(container);
            const statuses = () => container.querySelectorAll(
                '[role="status"][aria-live="polite"][aria-atomic="true"]',
            );
            expect(statuses()).toHaveLength(1);
            const status = statuses()[0];
            expect(status?.getAttribute('data-searchable-listbox-range'))
                .not.toBeNull();
            expect(status?.textContent).toBe('Showing 1–100 of 250 options.');

            await setSearch(container, 'key-24');
            expect(statuses()).toHaveLength(1);
            expect(statuses()[0]).toBe(status);
            expect(status?.textContent).toBe('Showing 1–11 of 11 options.');

            await setSearch(container, 'missing-needle');
            expect(statuses()).toHaveLength(1);
            expect(statuses()[0]).toBe(status);
            expect(status?.textContent).toBe('No options match this search.');
            expect(container.querySelector('[data-searchable-listbox-empty]')
                ?.getAttribute('aria-hidden')).toBe('true');
        });

    it('blocks a stale search commit, then commits only Enter and touch click once',
        async () => {
            const onSelect = vi.fn();
            const options = fixtureOptions(101);
            await renderSelector({ onSelect, options });
            await clickTrigger(container);
            const stale = container.querySelector<HTMLElement>('[role="option"]');
            const search = searchInput(container);
            const setter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                'value',
            )?.set;
            if (!setter || !stale) throw new Error('Expected stale search fixture.');
            await act(async () => {
                setter.call(search, 'key-100');
                search.dispatchEvent(new Event('input', { bubbles: true }));
                stale.click();
            });
            expect(onSelect).not.toHaveBeenCalled();

            await key(searchInput(container), 'Enter');
            expect(onSelect).toHaveBeenCalledTimes(1);
            expect(onSelect.mock.calls[0]?.[0]).toMatchObject({ key: 'key-100' });
            await clickTrigger(container);
            const option = container.querySelector<HTMLElement>('[role="option"]');
            if (!option) throw new Error('Expected filtered option.');
            const touchClick = new MouseEvent('click', { bubbles: true });
            Object.defineProperty(touchClick, 'pointerType', { value: 'touch' });
            await act(async () => option.dispatchEvent(touchClick));
            expect(onSelect).toHaveBeenCalledTimes(2);
            expect(onSelect.mock.calls[1]?.[0]).toMatchObject({ key: 'key-0' });
        });

    it('moves the active descendant across pages and restores trigger focus on Escape',
        async () => {
            await renderSelector({
                options: fixtureOptions(250),
                selectedKey: 'key-99',
            });
            const trigger = await clickTrigger(container);
            const search = searchInput(container);
            expect(search.getAttribute('aria-activedescendant'))
                .toBe('run-source-option-99');
            await key(search, 'ArrowDown');
            expect(rangeText(container)).toBe('Showing 101–200 of 250 options.');
            expect(search.getAttribute('aria-activedescendant'))
                .toBe('run-source-option-100');
            const active = container.querySelector<HTMLElement>('[data-active="true"]');
            expect(active?.id).toBe('run-source-option-100');
            expect(active?.getAttribute('aria-selected')).toBe('false');
            expect(container.querySelector('[data-searchable-listbox-trigger]')?.textContent)
                .toContain('Option 99');
            await key(search, 'End');
            expect(rangeText(container)).toBe('Showing 201–250 of 250 options.');
            expect(search.getAttribute('aria-activedescendant'))
                .toBe('run-source-option-249');
            await key(search, 'Home');
            expect(rangeText(container)).toBe('Showing 1–100 of 250 options.');
            expect(search.getAttribute('aria-activedescendant'))
                .toBe('run-source-option-0');
            await key(search, 'PageDown');
            expect(rangeText(container)).toBe('Showing 101–200 of 250 options.');
            await key(search, 'PageUp');
            expect(rangeText(container)).toBe('Showing 1–100 of 250 options.');
            await key(search, 'Escape');
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
            expect(document.activeElement).toBe(trigger);
        });

    it.each(['Enter', ' ', 'ArrowDown', 'ArrowUp'])(
        'opens from the disclosure trigger with %s without committing',
        async (triggerKey) => {
            const onSelect = vi.fn();
            await renderSelector({ onSelect, options: fixtureOptions(101) });
            const trigger = container.querySelector<HTMLButtonElement>(
                '[data-searchable-listbox-trigger]',
            );
            if (!trigger) throw new Error('Expected trigger.');
            await key(trigger, triggerKey);
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(100);
            expect(document.activeElement).toBe(searchInput(container));
            expect(onSelect).not.toHaveBeenCalled();
        },
    );

    it('closes on Tab without preventing navigation or implicitly committing',
        async () => {
            const onSelect = vi.fn();
            await renderSelector({ onSelect, options: fixtureOptions(101) });
            await clickTrigger(container);
            const tab = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'Tab',
            });
            await act(async () => searchInput(container).dispatchEvent(tab));
            expect(tab.defaultPrevented).toBe(false);
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
            expect(onSelect).not.toHaveBeenCalled();
        });

    it.each(['Previous', 'Next', 'range', 'option'] as const)(
        'handles Escape from every popup surface (%s) and restores the disclosure trigger',
        async (targetKind) => {
            const onSelect = vi.fn();
            await renderSelector({ onSelect, options: fixtureOptions(201) });
            const trigger = await clickTrigger(container);
            const target = targetKind === 'range'
                ? container.querySelector<HTMLElement>(
                    '[data-searchable-listbox-focus-anchor]',
                )
                : targetKind === 'option'
                ? container.querySelector<HTMLElement>('[role="option"]')
                : windowButton(container, targetKind);
            if (!target) throw new Error(`Expected popup target ${targetKind}.`);
            target.focus();
            await key(target, 'Escape');
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
            expect(document.activeElement).toBe(trigger);
            expect(onSelect).not.toHaveBeenCalled();
        },
    );

    it('dismisses on Tab from a window control and outside pointer or focus',
        async () => {
            const onSelect = vi.fn();
            await renderSelector({ onSelect, options: fixtureOptions(201) });
            await clickTrigger(container);
            const next = windowButton(container, 'Next');
            if (!next) throw new Error('Expected Next.');
            next.focus();
            const tab = new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'Tab',
            });
            await act(async () => next.dispatchEvent(tab));
            expect(tab.defaultPrevented).toBe(false);
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);

            const outside = container.querySelector<HTMLButtonElement>(
                '[data-test-outside-target]',
            );
            if (!outside) throw new Error('Expected outside target.');
            expect(container.querySelector('[data-searchable-windowed-listbox]')
                ?.contains(outside)).toBe(false);
            await clickTrigger(container);
            await act(async () => outside.dispatchEvent(new Event('pointerdown', {
                bubbles: true,
            })));
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);

            await clickTrigger(container);
            await act(async () => outside.focus());
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
            expect(onSelect).not.toHaveBeenCalled();
        });

    it('uses one focused editable combobox owner inside a disclosure popup', async () => {
        await renderSelector({ options: fixtureOptions(101) });
        const trigger = await clickTrigger(container);
        expect(trigger.getAttribute('role')).toBeNull();
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
        const search = searchInput(container);
        expect(search.id).toBe('run-source-search');
        expect(container.querySelector('label[for="run-source-search"]'))
            .not.toBeNull();
        expect(search.getAttribute('role')).toBe('combobox');
        expect(search.getAttribute('aria-expanded')).toBe('true');
        expect(search.getAttribute('aria-controls')).toBe('run-source-listbox');
        expect(document.activeElement).toBe(search);
    });

    it('toggles the disclosure closed without committing', async () => {
        const onSelect = vi.fn();
        await renderSelector({ onSelect, options: fixtureOptions(101) });
        const trigger = await clickTrigger(container);
        await act(async () => trigger.click());
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('keyboard-toggles and escapes an expanded duplicate-key error on the trigger',
        async () => {
            const duplicateKey = 'duplicate-key';
            const options: readonly SearchableListboxOption[] = [
                { key: duplicateKey, value: 'one', label: 'One', searchText: 'one' },
                { key: duplicateKey, value: 'two', label: 'Two', searchText: 'two' },
            ];
            await renderSelector({ options });
            const trigger = container.querySelector<HTMLButtonElement>(
                '[data-searchable-listbox-trigger]',
            );
            if (!trigger) throw new Error('Expected duplicate-key trigger.');
            trigger.focus();
            await key(trigger, 'Enter');
            expect(document.activeElement).toBe(trigger);
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            await key(trigger, 'Enter');
            expect(trigger.getAttribute('aria-expanded')).toBe('false');

            await key(trigger, ' ');
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            await key(trigger, 'Escape');
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
            expect(document.activeElement).toBe(trigger);
        });

    it('does not navigate, commit, or dismiss while an IME composition is active',
        async () => {
            const onSelect = vi.fn();
            await renderSelector({ onSelect, options: fixtureOptions(101) });
            await clickTrigger(container);
            const search = searchInput(container);
            const initialActive = search.getAttribute('aria-activedescendant');
            await composingKey(search, 'ArrowDown');
            expect(search.getAttribute('aria-activedescendant')).toBe(initialActive);
            await composingKey(search, 'Enter');
            expect(onSelect).not.toHaveBeenCalled();
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(100);
            await legacyCompositionKey(search, 'Enter');
            expect(onSelect).not.toHaveBeenCalled();
            await composingKey(search, 'Escape');
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(100);
            expect(document.activeElement).toBe(search);
        });

    it('re-reveals a high controlled selection after a batched filtered reopen',
        async () => {
            const options = fixtureOptions(250);
            await renderSelector({ options, selectedKey: 'key-217' });
            const trigger = await clickTrigger(container);
            await setSearch(container, 'key-0');
            expect(rangeText(container)).toBe('Showing 1–1 of 1 options.');
            const search = searchInput(container);
            await act(async () => {
                search.dispatchEvent(new KeyboardEvent('keydown', {
                    bubbles: true,
                    cancelable: true,
                    key: 'Escape',
                }));
                trigger.click();
            });
            expect(rangeText(container)).toBe('Showing 201–250 of 250 options.');
            expect(container.querySelector('[role="option"][aria-selected="true"]')
                ?.getAttribute('data-option-key')).toBe('key-217');
        });

    it('re-reveals a high controlled selection when an open context changes',
        async () => {
            const options = fixtureOptions(250);
            const revision = {};
            await renderSelector({
                contextKey: 'runs:a', options, revision, selectedKey: 'key-217',
            });
            await clickTrigger(container);
            expect(rangeText(container)).toBe('Showing 201–250 of 250 options.');

            await renderSelector({
                contextKey: 'runs:b', options, revision, selectedKey: 'key-217',
            });
            expect(rangeText(container)).toBe('Showing 201–250 of 250 options.');
            expect(container.querySelector('[data-active="true"]')?.id)
                .toBe('run-source-option-217');
        });

    it('rejects duplicate controlled keys with exact unavailable truth', async () => {
        const duplicateKey = 'duplicate\u202e/key';
        const options: readonly SearchableListboxOption[] = [
            { key: duplicateKey, value: 'one', label: 'First', searchText: 'first' },
            { key: duplicateKey, value: 'two', label: 'Second', searchText: 'second' },
        ];
        const onSelect = vi.fn();
        await renderSelector({ onSelect, options, selectedKey: duplicateKey });
        await clickTrigger(container);
        expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
        const error = container.querySelector('[data-searchable-listbox-key-error]');
        expect(error?.getAttribute('role')).toBe('alert');
        expect(error?.textContent).toContain('option keys must be unique');
        expect(error?.querySelector('bdi')?.getAttribute('dir')).toBe('ltr');
        expect(error?.querySelector('bdi')?.textContent).toBe(duplicateKey);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('keeps duplicate values distinct and renders long bidi identifiers exactly',
        async () => {
            const exact = 'run/late\u202e/\u754c/' + 'x'.repeat(180);
            const options: readonly SearchableListboxOption[] = [
                {
                    key: 'first', value: 'duplicate', label: 'First duplicate',
                    searchText: 'first duplicate',
                },
                {
                    key: 'second',
                    value: 'duplicate',
                    label: 'Second duplicate',
                    searchText: 'second duplicate',
                    exactIdentifier: exact,
                },
            ];
            const onSelect = vi.fn();
            await renderSelector({ onSelect, options, selectedKey: 'second' });
            await clickTrigger(container);

            const rows = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
            expect(rows.map(row => row.id)).toEqual([
                'run-source-option-0',
                'run-source-option-1',
            ]);
            expect(rows.every(row => !row.id.includes('duplicate'))).toBe(true);
            const exactOwner = rows[1]?.querySelector('bdi[data-exact-identifier]');
            expect(exactOwner?.getAttribute('dir')).toBe('ltr');
            expect(exactOwner?.textContent).toBe(exact);
            await act(async () => rows[0]?.click());
            expect(onSelect).toHaveBeenCalledWith(options[0]);
        });

    it('reports disabled, unavailable, and empty states without inventing a selection',
        async () => {
            const options = fixtureOptions(1);
            await renderSelector({ disabled: true, options, selectedKey: 'key-0' });
            const disabledTrigger = container.querySelector<HTMLButtonElement>(
                '[data-searchable-listbox-trigger]',
            );
            expect(disabledTrigger?.disabled).toBe(true);
            await act(async () => disabledTrigger?.click());
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);

            await renderSelector({ options, selectedKey: 'missing\u202e/id' });
            expect(container.querySelector('[data-searchable-listbox-unavailable]')
                ?.textContent).toContain('missing\u202e/id');
            expect(container.querySelector('[data-searchable-listbox-unavailable] bdi')
                ?.getAttribute('dir')).toBe('ltr');
            await clickTrigger(container);
            expect(rangeText(container)).toBe('Showing 1–1 of 1 options.');

            await key(searchInput(container), 'Escape');
            await renderSelector({ options: [] });
            await clickTrigger(container);
            expect(rangeText(container)).toBe('No options available.');
            expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
        });

    it('hands focus to a persistent enabled fallback when an open picker is disabled',
        async () => {
            const options = fixtureOptions(101);
            await renderSelector({ options });
            await clickTrigger(container);
            expect(document.activeElement).toBe(searchInput(container));

            await renderSelector({ disabled: true, options });

            const trigger = container.querySelector<HTMLButtonElement>(
                '[data-searchable-listbox-trigger]',
            );
            const fallback = container.querySelector<HTMLElement>(
                '[data-searchable-listbox-disabled-focus]',
            );
            expect(trigger?.disabled).toBe(true);
            expect(container.querySelector('[data-searchable-listbox-popup]')).toBeNull();
            expect(fallback).not.toBeNull();
            expect(fallback?.matches(':disabled')).toBe(false);
            expect(document.activeElement).toBe(fallback);
            expect(document.activeElement).not.toBe(document.body);
        });

    it('does not steal external focus when an open picker becomes disabled',
        async () => {
            const options = fixtureOptions(101);
            await renderSelector({ options });
            await clickTrigger(container);
            const outside = container.querySelector<HTMLButtonElement>(
                '[data-test-outside-target]',
            );
            if (!outside) throw new Error('Expected outside target.');
            const retainOpen = (event: Event) => event.stopImmediatePropagation();
            window.addEventListener('focusin', retainOpen, true);
            outside.focus();
            window.removeEventListener('focusin', retainOpen, true);
            expect(document.activeElement).toBe(outside);
            expect(container.querySelector('[data-searchable-listbox-popup]'))
                .not.toBeNull();

            await renderSelector({ disabled: true, options });

            expect(container.querySelector('[data-searchable-listbox-popup]')).toBeNull();
            expect(document.activeElement).toBe(outside);
        });

    it('recovers focused window controls when an option revision crosses the budget',
        async () => {
            const firstRevision = {};
            await renderSelector({
                options: fixtureOptions(101),
                revision: firstRevision,
            });
            await clickTrigger(container);
            const next = windowButton(container, 'Next');
            next?.focus();
            expect(document.activeElement).toBe(next);

            await renderSelector({
                options: fixtureOptions(100),
                revision: {},
            });
            const anchor = container.querySelector<HTMLElement>(
                '[data-searchable-listbox-focus-anchor]',
            );
            expect(container.querySelector('[aria-label="Run source options window"]'))
                .toBeNull();
            expect(document.activeElement).toBe(anchor);
            expect(anchor?.textContent).toBe('Showing 1–100 of 100 options.');
        });

    it('uses coarse logical targets, bidi isolation, and reduced-motion containment', () => {
        const css = readFileSync(resolve(
            repoRoot,
            'apps/rallar-black-box/src/recipe-console/ui/SearchableWindowedListbox.module.css',
        ), 'utf8');
        expect(css).toContain('min-inline-size: 44px');
        expect(css).toContain('min-block-size: 44px');
        expect(css).toContain('padding-inline:');
        expect(css).toMatch(/unicode-bidi:\s*isolate/);
        expect(css).toMatch(/\.option\[data-active="true"\]/);
        expect(css).toMatch(
            /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/,
        );
        expect(css).not.toMatch(/(?:margin|padding|inset|border)-(?:left|right):/);
    });

    it('keeps the closed selected option compact without flattening popup rows', () => {
        const css = readFileSync(resolve(
            repoRoot,
            'apps/rallar-black-box/src/recipe-console/ui/SearchableWindowedListbox.module.css',
        ), 'utf8');
        const selectionRule = css.match(/\.selection \.optionBody\s*\{([^}]*)\}/u)?.[1];
        const identifierRule = css.match(
            /\.selection \.optionBody > \[data-exact-identifier\]\s*\{([^}]*)\}/u,
        )?.[1];
        const detailRule = css.match(
            /\.selection \.optionBody > small\s*\{([^}]*)\}/u,
        )?.[1];

        expect(selectionRule).toMatch(/display:\s*flex/u);
        expect(selectionRule).toMatch(/white-space:\s*nowrap/u);
        expect(identifierRule).toMatch(/order:\s*1/u);
        expect(css).toMatch(
            /\.selection \.optionBody > \[data-exact-identifier\]::after\s*\{[^}]*content:\s*["'] · ["']/u,
        );
        expect(detailRule).toMatch(/display:\s*none/u);
        expect(css).not.toMatch(/\.option > \.optionBody > small\s*\{[^}]*display:\s*none/u);
    });
});

function fixtureOptions(count: number): readonly SearchableListboxOption[] {
    return Array.from({ length: count }, (_, index) => ({
        key: `key-${index}`,
        value: `value-${index % 2}`,
        label: `Option ${index}`,
        searchText: `key-${index} option-${index}`,
        detail: `Source ordinal ${index}`,
    }));
}

async function clickTrigger(container: HTMLElement): Promise<HTMLButtonElement> {
    const trigger = container.querySelector<HTMLButtonElement>(
        '[data-searchable-listbox-trigger]',
    );
    if (!trigger) throw new Error('Expected listbox trigger.');
    await act(async () => trigger.click());
    return trigger;
}

function searchInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
        'input[type="search"][role="combobox"]',
    );
    if (!input) throw new Error('Expected listbox search input.');
    return input;
}

async function setSearch(container: HTMLElement, value: string): Promise<void> {
    const input = searchInput(container);
    const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
    )?.set;
    if (!setter) throw new Error('Expected native input setter.');
    await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function key(target: HTMLElement, value: string): Promise<void> {
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: value,
    })));
}

async function composingKey(target: HTMLElement, value: string): Promise<void> {
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        isComposing: true,
        key: value,
    })));
}

async function legacyCompositionKey(target: HTMLElement, value: string): Promise<void> {
    const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: value,
    });
    Object.defineProperty(event, 'keyCode', { value: 229 });
    await act(async () => target.dispatchEvent(event));
}

function rangeText(container: HTMLElement): string | null | undefined {
    return container.querySelector('[data-searchable-listbox-range]')?.textContent;
}

function windowButton(
    container: HTMLElement,
    label: 'Previous' | 'Next',
): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent === label);
}

async function clickWindow(
    container: HTMLElement,
    label: 'Previous' | 'Next',
): Promise<void> {
    const button = windowButton(container, label);
    if (!button) throw new Error(`Expected ${label} window button.`);
    await act(async () => button.click());
}

async function traverse(
    container: HTMLElement,
    direction: 'Previous' | 'Next',
): Promise<string[]> {
    const pages: string[][] = [];
    while (true) {
        pages.push([...container.querySelectorAll<HTMLElement>('[role="option"]')]
            .map(option => option.dataset.optionKey ?? ''));
        const button = windowButton(container, direction);
        if (!button || button.disabled) break;
        await act(async () => button.click());
    }
    if (direction === 'Previous') pages.reverse();
    return pages.flat();
}
