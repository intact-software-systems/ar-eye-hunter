const WINDOW_ANCHOR_ATTRIBUTES = [
    {
        anchor: 'data-monitor-window-focus-anchor',
        owner: 'data-monitor-window-owner',
    },
    {
        anchor: 'data-fleet-window-focus-anchor',
        owner: 'data-fleet-window-owner',
    },
] as const;

export function owningWindowFocusAnchor(
    trigger: HTMLElement,
): HTMLElement | null {
    const shell = trigger.closest<HTMLElement>('[data-recipe-console-shell]');
    if (!shell) return null;

    for (const attributes of WINDOW_ANCHOR_ATTRIBUTES) {
        const owner = trigger.closest<HTMLElement>(`[${attributes.owner}]`)
            ?.getAttribute(attributes.owner);
        if (!owner) continue;
        const anchor = Array.from(shell.querySelectorAll<HTMLElement>(
            `[${attributes.anchor}][${attributes.owner}]`,
        )).find(candidate =>
            candidate.getAttribute(attributes.owner) === owner
        );
        if (anchor) return anchor;
    }
    return null;
}
