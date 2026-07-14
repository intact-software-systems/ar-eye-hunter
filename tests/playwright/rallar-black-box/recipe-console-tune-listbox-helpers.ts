import { expect, type Locator, type Page } from '@playwright/test';

type TuneListboxOwner = Page | Locator;

export function tuneListboxTrigger(
    owner: TuneListboxOwner,
    label: string,
): Locator {
    return owner.getByRole('group', { name: label, exact: true })
        .locator('[data-searchable-listbox-trigger]');
}

export async function openTuneListbox(
    owner: TuneListboxOwner,
    label: string,
): Promise<Locator> {
    const trigger = tuneListboxTrigger(owner, label);
    await trigger.click();
    const search = owner.getByRole('combobox', { name: `Search ${label}` });
    const popup = search.locator(
        'xpath=ancestor::*[@data-searchable-listbox-popup][1]',
    );
    await expect(popup).toBeVisible();
    return popup;
}

export async function chooseTuneListboxOption(
    owner: TuneListboxOwner,
    label: string,
    value: string,
): Promise<void> {
    const popup = await openTuneListbox(owner, label);
    const search = popup.getByRole('combobox', { name: `Search ${label}` });
    await search.fill(value);
    const option = popup.getByRole('option').filter({ hasText: value }).first();
    await expect(option).toHaveAttribute('data-option-key', value);
    await option.click();
}

export async function chooseTuneListboxOptionWithKeyboard(
    owner: TuneListboxOwner,
    label: string,
    value: string,
): Promise<void> {
    const trigger = tuneListboxTrigger(owner, label);
    await trigger.focus();
    await trigger.press('ArrowDown');
    const search = owner.getByRole('combobox', { name: `Search ${label}` });
    await expect(search).toBeFocused();
    const popup = search.locator(
        'xpath=ancestor::*[@data-searchable-listbox-popup][1]',
    );
    await expect(popup).toHaveAttribute('aria-busy', 'false');
    await search.fill(value);
    await expect(popup).toHaveAttribute('aria-busy', 'false');
    const option = popup.getByRole('option').filter({ hasText: value }).first();
    await expect(option).toHaveAttribute('data-option-key', value);
    const optionId = await option.getAttribute('id');
    if (optionId === null) {
        throw new Error(`Expected ${label} option ${value} to have an id.`);
    }
    await expect(search).toHaveAttribute('aria-activedescendant', optionId);
    await search.press('Enter');
}

export async function visibleTuneListboxValues(
    owner: TuneListboxOwner,
    label: string,
): Promise<string[]> {
    const popup = await openTuneListbox(owner, label);
    const values = await popup.getByRole('option').evaluateAll(options =>
        options.map(option => option.getAttribute('data-option-key') ?? '')
    );
    await popup.getByRole('combobox', { name: `Search ${label}` }).press('Escape');
    return values;
}
