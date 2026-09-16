import type { AuthSession } from '@shared/api/api-config.ts';
import { CollapsiblePanelSection } from '../../shared/CollapsiblePanelSection.tsx';
import type { AuthCommandCenterModel, AuthCommandCenterPanelProps } from './auth-command-center-contracts.ts';
import { AuthCommandCenterEvidence } from './auth-command-center-evidence.tsx';
import { useAuthCommandCenterController } from './use-auth-command-center-controller.ts';

interface AuthInputsSectionProps {
    readonly model: AuthCommandCenterModel;
    /** Absent while the browser is signed out. */
    readonly authSession: AuthSession | undefined;
}

interface AuthActionButtonsProps extends AuthInputsSectionProps {
    onLogout(): Promise<void>;
}

interface AuthActionButton {
    readonly label: string;
    readonly disabled: boolean;
    onClick(): void;
}

export function AuthCommandCenterPanel(props: AuthCommandCenterPanelProps) {
    const model = useAuthCommandCenterController(props);
    const { authSession } = props;
    return (
        <section className="panel auth-command-center-panel">
            <div className="panel-heading">
                <h2>Auth Command Center</h2>
                <span className={`pill ${authSession ? 'good' : 'warn'}`}>
                    {authSession ? 'session active' : 'no session'}
                </span>
            </div>
            <AuthInputsSection model={model} authSession={authSession} />
            <AuthActionButtons model={model} authSession={authSession} onLogout={props.onLogout} />
            <AuthCommandCenterEvidence model={model} state={props.state} authSession={authSession} />
        </section>
    );
}

function AuthInputsSection({ model, authSession }: AuthInputsSectionProps) {
    return (
        <CollapsiblePanelSection title="Auth Inputs" meta={authSession ? authSession.username : 'not logged in'}>
            <div className="auth-command-grid">
                <label className="field">
                    <span>API Base URL</span>
                    <input value={model.apiBaseUrl} onChange={(event) => model.setApiBaseUrl(event.target.value)} />
                </label>
                <label className="field">
                    <span>Username</span>
                    <input
                        value={model.username}
                        onChange={(event) => model.setUsername(event.target.value)}
                        autoCapitalize="none"
                        autoComplete="username"
                        autoCorrect="off"
                        spellCheck={false}
                    />
                </label>
                <label className="field">
                    <span>Password</span>
                    <input
                        type="password"
                        value={model.password}
                        onChange={(event) => model.setPassword(event.target.value)}
                        autoComplete="current-password"
                    />
                </label>
            </div>
        </CollapsiblePanelSection>
    );
}

function AuthActionButtons({ model, authSession, onLogout }: AuthActionButtonsProps) {
    const busy = Boolean(model.busyAction);
    const buttons: readonly AuthActionButton[] = [
        { label: 'Login', disabled: busy, onClick: () => void model.login() },
        { label: 'Register and login', disabled: busy, onClick: () => void model.registerAndLogin() },
        { label: 'Restore session', disabled: busy, onClick: model.restore },
        { label: 'Logout', disabled: busy || !authSession, onClick: () => void onLogout() },
        { label: 'Clear local session', disabled: busy, onClick: model.clearLocal },
        { label: 'Create WS ticket', disabled: busy || !authSession, onClick: () => void model.createWsTicket() },
        { label: 'Bad credentials', disabled: busy, onClick: () => void model.negativeLogin() },
        { label: 'Missing auth ticket', disabled: busy, onClick: () => void model.negativeWsTicket() },
        { label: 'Expired auth ticket', disabled: busy || !authSession, onClick: () => void model.expiredWsTicket() },
        { label: 'Copy diagnostics', disabled: false, onClick: model.copyDiagnostics },
        { label: 'Copy auth recipe', disabled: false, onClick: model.copyRecipe }
    ];
    return (
        <div className="auth-action-grid">
            {buttons.map((button) => (
                <button key={button.label} type="button" disabled={button.disabled} onClick={button.onClick}>
                    {button.label}
                </button>
            ))}
        </div>
    );
}
