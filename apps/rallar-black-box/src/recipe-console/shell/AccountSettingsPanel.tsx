import type { AuthSession } from '@shared/api/api-config.ts';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { RecipeConsolePreferencesControllerValue } from '../app/RecipeConsolePreferencesController.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { accountSettingsDraftFromValues, AccountSettingsFields } from './AccountSettingsFields.tsx';
import styles from './AccountSettingsPanel.module.css';

export type RecipeConsoleAccountSettings = Readonly<{
    authBusy: boolean;
    authError?: string;
    authSession?: AuthSession;
    onLogout(): Promise<void>;
    preferences: RecipeConsolePreferencesControllerValue;
}>;

export type AccountSettingsPanelProps =
    & RecipeConsoleAccountSettings
    & Readonly<{
        lastControlError?: string;
    }>;

export function AccountSettingsPanel({
    authBusy,
    authError,
    authSession,
    lastControlError,
    onLogout,
    preferences
}: AccountSettingsPanelProps) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState(() =>
        accountSettingsDraftFromValues(
            preferences.state.values
        )
    );
    const [saveStatus, setSaveStatus] = useState<string>();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const initialFocusRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        setSaveStatus(undefined);
        initialFocusRef.current?.focus();
        return () => triggerRef.current?.focus();
    }, [open]);
    useEffect(() => {
        if (!open) {
            return;
        }
        setDraft(accountSettingsDraftFromValues(preferences.state.values));
    }, [
        open,
        preferences.state.values.apiBaseUrl,
        preferences.state.values.applicationId,
        preferences.state.values.controlReadTimeoutMs,
        preferences.state.values.controlUrl,
        preferences.state.values.groupId,
        preferences.state.values.workspaceId
    ]);

    function close(): void {
        setOpen(false);
    }

    function save(): void {
        const current = preferences.preferences;
        const locks = preferences.state.locks;
        const saved = preferences.save({
            controlUrl: locks.controlUrl
                ? current.controlUrl
                : optional(draft.controlUrl),
            apiBaseUrl: locks.apiBaseUrl
                ? current.apiBaseUrl
                : optional(draft.apiBaseUrl),
            applicationId: locks.applicationId
                ? current.applicationId
                : optional(draft.applicationId),
            workspaceId: locks.workspaceId
                ? current.workspaceId
                : optional(draft.workspaceId),
            groupId: locks.groupId
                ? current.groupId
                : optional(draft.groupId),
            controlReadTimeoutMs: Number(draft.controlReadTimeoutMs)
        });
        setSaveStatus(saved ? 'Defaults saved.' : undefined);
    }

    function reset(): void {
        const reset = preferences.reset();
        setSaveStatus(reset ? 'Defaults reset.' : undefined);
    }

    function trapFocus(event: KeyboardEvent<HTMLDivElement>): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
            ) ?? []
        );
        if (focusable.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
        }
        else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        }
    }

    function dismissFromBackdrop(event: MouseEvent<HTMLDivElement>): void {
        if (event.target === event.currentTarget) {
            close();
        }
    }

    return (
        <>
            <IconButton
                aria-expanded={open}
                aria-haspopup="dialog"
                aria-label="Open account and settings"
                icon="sliders"
                onClick={() => setOpen(true)}
                ref={triggerRef}
            />
            {open
                ? (
                    <div
                        className={styles.backdrop}
                        data-account-settings-backdrop
                        onMouseDown={dismissFromBackdrop}
                    >
                        <div
                            aria-labelledby="account-settings-heading"
                            aria-modal="true"
                            className={styles.panel}
                            data-account-settings-panel
                            onKeyDown={trapFocus}
                            ref={dialogRef}
                            role="dialog"
                            tabIndex={-1}
                        >
                            <header className={styles.header}>
                                <div>
                                    <p className={styles.eyebrow}>Recipe Console</p>
                                    <h2 id="account-settings-heading">
                                        Account and settings
                                    </h2>
                                </div>
                                <IconButton
                                    aria-label="Close account and settings"
                                    icon="close"
                                    onClick={close}
                                />
                            </header>

                            <section aria-labelledby="account-heading" className={styles.section}>
                                <div className={styles.sectionHeading}>
                                    <h3 id="account-heading">Account</h3>
                                    <span
                                        className={`${styles.sessionState} ${
                                            authSession ? '' : styles.inactiveSession
                                        }`}
                                    >
                                        {authSession ? 'Session active' : 'No active session'}
                                    </span>
                                </div>
                                <p className={styles.accountName}>
                                    {authSession?.username ?? 'No authenticated account'}
                                </p>
                                {authError ? <p className={styles.error} role="alert">{authError}</p> : null}
                                <button
                                    className={styles.secondaryButton}
                                    disabled={authBusy || !authSession}
                                    onClick={() => void onLogout()}
                                    type="button"
                                >
                                    {authBusy ? 'Logging out…' : 'Logout'}
                                </button>
                            </section>

                            <section aria-labelledby="defaults-heading" className={styles.section}>
                                <div className={styles.sectionHeading}>
                                    <div>
                                        <h3 id="defaults-heading">Personal defaults</h3>
                                        <p>Stored only in this browser.</p>
                                    </div>
                                </div>
                                <AccountSettingsFields
                                    draft={draft}
                                    initialFocusRef={initialFocusRef}
                                    locks={preferences.state.locks}
                                    onChange={(next) => {
                                        setDraft(next);
                                        setSaveStatus(undefined);
                                    }}
                                />
                                {preferences.error
                                    ? (
                                        <p className={styles.error} role="alert">
                                            {preferences.error}
                                        </p>
                                    )
                                    : null}
                                {lastControlError
                                    ? (
                                        <div className={styles.controlError} role="status">
                                            <strong>Latest control error</strong>
                                            <span>{lastControlError}</span>
                                        </div>
                                    )
                                    : null}
                                {saveStatus ? <p className={styles.success} role="status">{saveStatus}</p> : null}
                                <div className={styles.actions}>
                                    <button
                                        className={styles.secondaryButton}
                                        onClick={reset}
                                        type="button"
                                    >
                                        Reset defaults
                                    </button>
                                    <button
                                        className={styles.primaryButton}
                                        onClick={save}
                                        type="button"
                                    >
                                        Save defaults
                                    </button>
                                </div>
                            </section>
                        </div>
                    </div>
                )
                : null}
        </>
    );
}

function optional(value: string): string | undefined {
    return value.trim() || undefined;
}
