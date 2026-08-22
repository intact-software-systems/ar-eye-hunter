import type { RefObject } from 'react';
import type {
    RecipeConsoleManagedPreferenceField,
    RecipeConsolePreferenceLocks,
    RecipeConsolePreferences
} from '../app/recipe-console-preferences.ts';
import styles from './AccountSettingsPanel.module.css';

export type AccountSettingsDraft = Readonly<{
    controlUrl: string;
    apiBaseUrl: string;
    applicationId: string;
    workspaceId: string;
    groupId: string;
    controlReadTimeoutMs: string;
}>;

const FIELDS = [
    ['controlUrl', 'Control URL'],
    ['apiBaseUrl', 'API URL'],
    ['applicationId', 'Application'],
    ['workspaceId', 'Workspace'],
    ['groupId', 'Group']
] as const;

export function AccountSettingsFields({
    draft,
    initialFocusRef,
    locks,
    onChange
}: Readonly<{
    draft: AccountSettingsDraft;
    initialFocusRef: RefObject<HTMLInputElement | null>;
    locks: RecipeConsolePreferenceLocks;
    onChange(draft: AccountSettingsDraft): void;
}>) {
    return (
        <div className={styles.fields}>
            {FIELDS.map(([field, label], index) => (
                <PreferenceField
                    draft={draft}
                    field={field}
                    initialFocusRef={index === 0 ? initialFocusRef : undefined}
                    key={field}
                    label={label}
                    lock={locks[field]}
                    onChange={(value) => onChange({ ...draft, [field]: value })}
                />
            ))}
            <label className={styles.field}>
                <span>Control read timeout (ms)</span>
                <input
                    inputMode="numeric"
                    max={120_000}
                    min={1_000}
                    onChange={(event) =>
                        onChange({
                            ...draft,
                            controlReadTimeoutMs: event.target.value
                        })}
                    step={1_000}
                    type="number"
                    value={draft.controlReadTimeoutMs}
                />
                <small>1–120 seconds</small>
            </label>
        </div>
    );
}

function PreferenceField({
    draft,
    field,
    initialFocusRef,
    label,
    lock,
    onChange
}: Readonly<{
    draft: AccountSettingsDraft;
    field: RecipeConsoleManagedPreferenceField;
    initialFocusRef?: RefObject<HTMLInputElement | null>;
    label: string;
    lock?: 'url' | 'deployment';
    onChange(value: string): void;
}>) {
    return (
        <label className={styles.field}>
            <span>{label}</span>
            <input
                disabled={Boolean(lock)}
                onChange={(event) => onChange(event.target.value)}
                ref={initialFocusRef}
                spellCheck={false}
                type={field === 'controlUrl' || field === 'apiBaseUrl'
                    ? 'url'
                    : 'text'}
                value={draft[field]}
            />
            {lock ? <small>Managed by {lock === 'url' ? 'URL' : 'deployment'}</small> : null}
        </label>
    );
}

export function accountSettingsDraftFromValues(
    values: Required<RecipeConsolePreferences>
): AccountSettingsDraft {
    return {
        controlUrl: values.controlUrl,
        apiBaseUrl: values.apiBaseUrl,
        applicationId: values.applicationId,
        workspaceId: values.workspaceId,
        groupId: values.groupId,
        controlReadTimeoutMs: String(values.controlReadTimeoutMs)
    };
}
