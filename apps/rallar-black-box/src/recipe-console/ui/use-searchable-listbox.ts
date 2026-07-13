import {
    useCallback,
    useDeferredValue,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ChangeEventHandler,
    type KeyboardEventHandler,
} from 'react';
import {
    SEARCHABLE_LISTBOX_WINDOW_SIZE,
    duplicateSearchableListboxKey,
    filterSearchableListboxRows,
    findSearchableListboxRow,
    normalizedSearch,
    searchableListboxFingerprint,
    type SearchableListboxOption,
    type SearchableListboxRow,
} from './searchable-listbox-model.ts';
import {
    useExplicitWindow,
    useExplicitWindowFocusRecovery,
} from './use-explicit-window.ts';
export type SearchableListboxInput = Readonly<{
    contextKey: string;
    disabled: boolean;
    options: readonly SearchableListboxOption[];
    revision?: object;
    selectedKey?: string;
    onSelect(option: SearchableListboxOption): void;
}>;
export function useSearchableListbox(input: SearchableListboxInput) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const [openGeneration, setOpenGeneration] = useState(0);
    const deferredQuery = useDeferredValue(query);
    const queryRef = useRef('');
    const openRef = useRef(false);
    const previousFingerprintRef = useRef<string | undefined>(undefined);
    const reconciledRef = useRef<Readonly<{
        contextKey: string; generation: number; revision: object; selectedKey?: string;
    }> | undefined>(undefined);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const revision = input.revision ?? input.options;
    const duplicateKey = useMemo(
        () => duplicateSearchableListboxKey(input.options),
        [input.options],
    );
    const rows = useMemo(() => open && duplicateKey === undefined
        ? filterSearchableListboxRows(input.options, deferredQuery)
        : [], [deferredQuery, duplicateKey, input.options, open]);
    const fingerprint = searchableListboxFingerprint(input.contextKey, deferredQuery);
    const explicitWindow = useExplicitWindow({
        fingerprint,
        revision,
        total: rows.length,
        windowSize: SEARCHABLE_LISTBOX_WINDOW_SIZE,
    });
    const focus = useExplicitWindowFocusRecovery(explicitWindow.model);
    const safeActiveIndex = rows.length === 0
        ? -1
        : Math.min(Math.max(0, activeIndex), rows.length - 1);
    const activeRow = rows[safeActiveIndex];
    const activeIsVisible = safeActiveIndex >= explicitWindow.model.startIndex &&
        safeActiveIndex < explicitWindow.model.endIndexExclusive;
    const pending = normalizedSearch(query) !== normalizedSearch(deferredQuery);
    const close = useCallback((restoreFocus: boolean) => {
        queryRef.current = '';
        openRef.current = false;
        setQuery('');
        setOpen(false);
        if (restoreFocus) triggerRef.current?.focus();
    }, []);
    const reveal = useCallback((index: number) => {
        if (rows.length === 0) return;
        const bounded = Math.min(Math.max(0, index), rows.length - 1);
        setActiveIndex(bounded);
        explicitWindow.revealIndex(bounded);
    }, [explicitWindow.revealIndex, rows.length]);
    const openListbox = useCallback(() => {
        if (input.disabled) return;
        queryRef.current = '';
        openRef.current = true;
        setQuery('');
        setOpen(true);
        setOpenGeneration(current => current + 1);
    }, [input.disabled]);
    const toggleListbox = useCallback(() => {
        if (openRef.current) close(false);
        else openListbox();
    }, [close, openListbox]);
    const commit = useCallback((row: SearchableListboxRow | undefined) => {
        if (
            input.disabled || !row ||
            normalizedSearch(queryRef.current) !== normalizedSearch(deferredQuery)
        ) return;
        input.onSelect(row.option);
        close(true);
    }, [close, deferredQuery, input.disabled, input.onSelect]);
    const browse = useCallback((direction: 'previous' | 'next') => {
        const target = direction === 'previous'
            ? Math.max(0, explicitWindow.model.startIndex -
                explicitWindow.model.windowSize)
            : Math.min(rows.length - 1, explicitWindow.model.endIndexExclusive);
        setActiveIndex(Math.max(0, target));
        if (direction === 'previous') explicitWindow.previous();
        else explicitWindow.next();
    }, [explicitWindow, rows.length]);
    const onQueryChange = useCallback<ChangeEventHandler<HTMLInputElement>>(event => {
        queryRef.current = event.currentTarget.value;
        setQuery(event.currentTarget.value);
    }, []);
    const onSearchKeyDown = useCallback<KeyboardEventHandler<HTMLInputElement>>(
        event => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            const moves: Partial<Record<string, number>> = {
                ArrowDown: safeActiveIndex + 1,
                ArrowUp: safeActiveIndex - 1,
                End: rows.length - 1,
                Home: 0,
            };
            if (event.key in moves) {
                event.preventDefault();
                reveal(moves[event.key] ?? 0);
            } else if (event.key === 'PageDown' || event.key === 'PageUp') {
                event.preventDefault();
                browse(event.key === 'PageDown' ? 'next' : 'previous');
            } else if (event.key === 'Enter') {
                event.preventDefault();
                commit(activeRow);
            }
        },
        [activeRow, browse, commit, reveal, rows.length, safeActiveIndex],
    );
    useLayoutEffect(() => {
        if (
            previousFingerprintRef.current !== undefined &&
            previousFingerprintRef.current !== fingerprint
        ) setActiveIndex(0);
        previousFingerprintRef.current = fingerprint;
    }, [fingerprint]);
    useLayoutEffect(() => {
        if (open) searchRef.current?.focus();
    }, [open, openGeneration]);
    useLayoutEffect(() => {
        if (!open || pending) return;
        const previous = reconciledRef.current;
        if (
            previous?.contextKey === input.contextKey &&
            previous.generation === openGeneration &&
            previous.revision === revision &&
            previous.selectedKey === input.selectedKey
        ) return;
        const selected = findSearchableListboxRow(rows, input.selectedKey);
        reveal(selected < 0 ? 0 : selected);
        reconciledRef.current = {
            contextKey: input.contextKey,
            generation: openGeneration,
            revision,
            ...(input.selectedKey === undefined
                ? {}
                : { selectedKey: input.selectedKey }),
        };
    }, [
        fingerprint,
        input.contextKey,
        input.selectedKey,
        open,
        openGeneration,
        pending,
        revision,
    ]);
    useLayoutEffect(() => {
        if (input.disabled && open) close(false);
    }, [close, input.disabled, open]);
    useEffect(() => {
        if (!open) return;
        const dismissOutside = (event: Event) => {
            const target = event.target;
            if (!(target instanceof Node) || rootRef.current?.contains(target)) return;
            close(false);
        };
        document.addEventListener('pointerdown', dismissOutside, true);
        document.addEventListener('focusin', dismissOutside, true);
        return () => {
            document.removeEventListener('pointerdown', dismissOutside, true);
            document.removeEventListener('focusin', dismissOutside, true);
        };
    }, [close, open]);
    return {
        activeRow: activeIsVisible ? activeRow : undefined,
        browseNext: () => browse('next'),
        browsePrevious: () => browse('previous'),
        close,
        commit,
        contentFocusProps: focus.contentFocusProps,
        duplicateKey,
        focusFallbackRef: focus.fallbackFocusRef,
        open,
        openListbox,
        pending,
        query,
        onQueryChange,
        onSearchKeyDown,
        rootRef,
        searchRef,
        triggerRef,
        toggleListbox,
        visibleRows: rows.slice(explicitWindow.model.startIndex,
            explicitWindow.model.endIndexExclusive),
        window: explicitWindow,
    } as const;
}
