import { type FormEvent, useState } from 'react';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    authenticateRallarBlackBox,
    authErrorMessage,
    bootstrapPatchFromAuthSession,
} from '../../auth-flow.ts';
import {
    type RallarBlackBoxBootstrapConfig,
    rallarBlackBoxRuntimeStore,
} from '../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../rallar/load-browser-rallar-facade.ts';

export function LoginScreen({
    bootstrap,
    onAuthenticated,
}: {
    bootstrap: RallarBlackBoxBootstrapConfig;
    onAuthenticated(session: AuthSession): void;
}) {
    const [apiBaseUrl, setApiBaseUrl] = useState(bootstrap.apiBaseUrl);
    const [username, setUsername] = useState(
        bootstrap.rallarUsername ?? bootstrap.actor,
    );
    const [password, setPassword] = useState(bootstrap.rallarPassword ?? '');
    const [register, setRegister] = useState(Boolean(bootstrap.rallarRegister));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>();

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setBusy(true);
        setError(undefined);

        try {
            const session = await authenticateRallarBlackBox(
                await loadBrowserRallarFacade(),
                {
                    apiBaseUrl,
                    username,
                    password,
                    register,
                },
            );
            rallarBlackBoxRuntimeStore.updateBootstrapConfig(
                bootstrapPatchFromAuthSession(session, apiBaseUrl),
            );
            onAuthenticated(session);
        } catch (authError) {
            setError(authErrorMessage(authError));
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="auth-shell">
            <section className="auth-panel">
                <div className="auth-heading">
                    <p className="eyebrow">Rallar Kit</p>
                    <h1>Rallar Server Login</h1>
                    <span className="pill active">
                        {bootstrap.providerMode}
                    </span>
                </div>
                <form
                    className="auth-form"
                    onSubmit={(event) => void submit(event)}
                >
                    <label className="field">
                        <span>API Base URL</span>
                        <input
                            value={apiBaseUrl}
                            onChange={(event) =>
                                setApiBaseUrl(event.target.value)
                            }
                            disabled={busy}
                            required
                        />
                    </label>
                    <label className="field">
                        <span>Username</span>
                        <input
                            value={username}
                            onChange={(event) =>
                                setUsername(event.target.value)
                            }
                            disabled={busy}
                            autoCapitalize="none"
                            autoComplete="username"
                            autoCorrect="off"
                            spellCheck={false}
                            required
                        />
                    </label>
                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            onChange={(event) =>
                                setPassword(event.target.value)
                            }
                            disabled={busy}
                            autoComplete="current-password"
                            required
                        />
                    </label>
                    <label className="check-field">
                        <input
                            type="checkbox"
                            checked={register}
                            onChange={(event) =>
                                setRegister(event.target.checked)
                            }
                            disabled={busy}
                        />
                        <span>Register before login</span>
                    </label>
                    <button
                        type="submit"
                        disabled={busy || !apiBaseUrl || !username || !password}
                    >
                        {busy ? 'Signing in' : 'Sign in'}
                    </button>
                </form>
                <dl className="auth-summary">
                    <div>
                        <dt>Room</dt>
                        <dd>{bootstrap.roomId}</dd>
                    </div>
                    <div>
                        <dt>Transport</dt>
                        <dd>{bootstrap.transport}</dd>
                    </div>
                    <div>
                        <dt>Source</dt>
                        <dd>{bootstrap.source}</dd>
                    </div>
                </dl>
                {error && (
                    <div className="workbench-error" role="status">
                        {error}
                    </div>
                )}
            </section>
        </main>
    );
}
