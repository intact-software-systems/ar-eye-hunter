import type { KeyboardEvent } from 'react';
import { ExactIdentifier } from './ExactIdentifier.tsx';
import { ExplicitWindowControls } from './ExplicitWindowControls.tsx';
import {
    searchableListboxOptionId,
    searchableListboxOutsideCount,
    searchableListboxRangeLabel,
    type SearchableListboxOption,
} from './searchable-listbox-model.ts';
import { useSearchableListbox } from './use-searchable-listbox.ts';
import styles from './SearchableWindowedListbox.module.css';

export type SearchableWindowedListboxProps = Readonly<{
    id: string;
    label: string;
    contextKey: string;
    options: readonly SearchableListboxOption[];
    revision?: object;
    selectedKey?: string;
    placeholder: string;
    disabled?: boolean;
    describedBy?: string;
    invalid?: boolean;
    onSelect(option: SearchableListboxOption): void;
}>;

export function SearchableWindowedListbox({
    id,
    label,
    contextKey,
    options,
    revision,
    selectedKey,
    placeholder,
    disabled = false,
    describedBy,
    invalid = false,
    onSelect,
}: SearchableWindowedListboxProps) {
    const state = useSearchableListbox({
        contextKey, disabled, onSelect, options, revision, selectedKey,
    });
    const selected = selectedKey === undefined || state.duplicateKey !== undefined
        ? undefined
        : options.find(option => option.key === selectedKey);
    const listboxId = `${id}-listbox`;
    const searchId = `${id}-search`;
    const range = searchableListboxRangeLabel(state.window.model, state.query);
    const outside = searchableListboxOutsideCount(state.window.model);

    function triggerKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
        if (event.key === 'Escape' && state.open) {
            event.preventDefault();
            state.close(true);
        } else if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            state.toggleListbox();
        }
    }

    function popupKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            state.close(true);
        } else if (event.key === 'Tab') {
            state.close(false);
        }
    }

    return (
        <div
            aria-labelledby={`${id}-label`}
            className={styles.root}
            data-searchable-listbox-disabled-focus
            data-searchable-windowed-listbox
            ref={state.rootRef}
            role="group"
            tabIndex={-1}
        >
            <span className={styles.label} id={`${id}-label`}>{label}</span>
            <button
                aria-controls={state.open ? listboxId : undefined}
                aria-describedby={describedBy}
                aria-expanded={state.open}
                aria-haspopup="listbox"
                aria-invalid={invalid || undefined}
                aria-labelledby={`${id}-label ${id}-selection`}
                className={styles.trigger}
                data-searchable-listbox-trigger
                disabled={disabled}
                id={`${id}-trigger`}
                onClick={state.toggleListbox}
                onKeyDown={triggerKeyDown}
                ref={state.triggerRef}
                type="button"
            >
                <span className={styles.selection} id={`${id}-selection`}>
                    {state.duplicateKey !== undefined ? 'Options unavailable'
                        : selected ? <OptionLabel option={selected} />
                        : selectedKey !== undefined ? (
                            <span data-searchable-listbox-unavailable>
                                Unavailable selection <ExactIdentifier value={selectedKey} />
                            </span>
                        ) : placeholder}
                </span>
                <span aria-hidden="true">⌄</span>
            </button>
            {state.open ? (
                <div
                    aria-busy={state.pending}
                    className={styles.popup}
                    data-searchable-listbox-popup
                    onKeyDownCapture={popupKeyDown}
                >
                    {state.duplicateKey !== undefined ? (
                        <p data-searchable-listbox-key-error role="alert">
                            Options unavailable: option keys must be unique. Duplicate key{' '}
                            <ExactIdentifier value={state.duplicateKey} />.
                        </p>
                    ) : null}
                    <label className={styles.search} htmlFor={searchId}>
                        <span>Search {label}</span>
                        <input
                            aria-activedescendant={state.activeRow
                                ? searchableListboxOptionId(id, state.activeRow)
                                : undefined}
                            aria-controls={listboxId}
                            aria-expanded="true"
                            aria-haspopup="listbox"
                            aria-autocomplete="list"
                            disabled={state.duplicateKey !== undefined}
                            id={searchId}
                            onChange={state.onQueryChange}
                            onKeyDown={state.onSearchKeyDown}
                            placeholder={`Search ${label.toLocaleLowerCase('en-US')}`}
                            ref={state.searchRef}
                            role="combobox"
                            type="search"
                            value={state.query}
                        />
                    </label>
                    {state.window.model.total > state.window.model.windowSize ? (
                        <div {...state.contentFocusProps}>
                            <ExplicitWindowControls
                                announceRange={false}
                                contentId={listboxId}
                                itemLabel="options"
                                label={`${label} options`}
                                model={state.window.model}
                                onNext={state.browseNext}
                                onPrevious={state.browsePrevious}
                                pending={state.pending}
                            />
                        </div>
                    ) : null}
                    <span
                        aria-atomic="true"
                        aria-live="polite"
                        className={styles.focusAnchor}
                        data-searchable-listbox-focus-anchor
                        data-searchable-listbox-range
                        ref={state.focusFallbackRef}
                        role="status"
                        tabIndex={-1}
                    >{range}</span>
                    {state.window.model.total > state.window.model.windowSize ? (
                        <p className={styles.truth} data-searchable-listbox-outside>
                            {outside.toLocaleString('en-US')} options outside this window and browseable.
                        </p>
                    ) : null}
                    <div
                        aria-label={`${label} options`}
                        className={styles.listbox}
                        id={listboxId}
                        role="listbox"
                        {...state.contentFocusProps}
                    >
                        {state.visibleRows.map(row => (
                            <button
                                aria-selected={row.option.key === selectedKey}
                                className={styles.option}
                                data-active={
                                    state.activeRow?.sourceIndex === row.sourceIndex
                                }
                                data-option-key={row.option.key}
                                id={searchableListboxOptionId(id, row)}
                                key={row.sourceIndex}
                                onClick={() => state.commit(row)}
                                role="option"
                                tabIndex={-1}
                                type="button"
                            ><OptionLabel option={row.option} /></button>
                        ))}
                    </div>
                    {state.window.model.total === 0 ? (
                        <p
                            aria-hidden="true"
                            className={styles.empty}
                            data-searchable-listbox-empty
                        >{range}</p>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function OptionLabel({ option }: Readonly<{ option: SearchableListboxOption }>) {
    return (
        <span className={styles.optionBody}>
            <strong>{option.label}</strong>
            {option.exactIdentifier !== undefined
                ? <ExactIdentifier value={option.exactIdentifier} />
                : null}
            {option.detail ? <small>{option.detail}</small> : null}
        </span>
    );
}
