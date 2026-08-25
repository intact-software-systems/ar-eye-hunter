import type { AuthSession } from '@shared/api/api-config.ts';
import type { QuickRallarTestViewModel } from './quick-rallar-contracts.ts';
interface QuickRallarTestActionSectionProps {
    readonly authSession?: AuthSession;
    readonly model: QuickRallarTestViewModel;
    onOpenAuth(): void;
    onOpenRunnerMode(): void;
}
export function QuickRallarTestActionSection(
    { authSession, model, onOpenAuth, onOpenRunnerMode }: QuickRallarTestActionSectionProps
) {
    return (
        <div className="quick-action-groups">
            <QuickRallarPrimaryActions
                authSession={authSession}
                model={model}
                onOpenAuth={onOpenAuth}
                onOpenRunnerMode={onOpenRunnerMode}
            />
            <QuickRallarSecondaryActions
                authSession={authSession}
                model={model}
                onOpenAuth={onOpenAuth}
                onOpenRunnerMode={onOpenRunnerMode}
            />
        </div>
    );
}

function QuickRallarPrimaryActions(
    { authSession, model, onOpenAuth, onOpenRunnerMode }: QuickRallarTestActionSectionProps
) {
    return (
        <div className="quick-action-group primary" aria-label="Primary Quick Test actions">
            {!model.realBackendReady && (
                <button type="button" className="primary-action" onClick={onOpenRunnerMode}>
                    Open runner mode
                </button>
            )}
            {model.realBackendReady && !authSession && (
                <button type="button" className="primary-action" onClick={onOpenAuth}>Open Auth</button>
            )}
            {model.canUseDirectRallar && !model.subscribed && (
                <button
                    type="button"
                    className="primary-action"
                    disabled={!model.activeGroupId}
                    onClick={() => void model.createGroup()}
                >
                    Create and join group
                </button>
            )}
            {model.canUseDirectRallar && !model.subscribed && (
                <button
                    type="button"
                    className="primary-action"
                    disabled={!model.activeGroupId || !model.activeTypeId}
                    onClick={() => void model.subscribeWs()}
                >
                    Subscribe WS
                </button>
            )}
            {model.canUseDirectRallar && (
                <button
                    type="button"
                    className="primary-action"
                    disabled={!model.setupComplete || !model.activeTypeId || !model.payloadResult.ok}
                    onClick={() => void model.sendWs()}
                >
                    Send WS JSON
                </button>
            )}
            {model.subscribed && (
                <button
                    type="button"
                    className="primary-action"
                    disabled={Boolean(model.busyAction)}
                    onClick={() => void model.waitForReceive()}
                >
                    Wait for receive
                </button>
            )}
        </div>
    );
}

function QuickRallarSecondaryActions(
    { model, onOpenRunnerMode }: QuickRallarTestActionSectionProps
) {
    return (
        <div className="quick-action-group secondary" aria-label="Secondary Quick Test actions">
            <button
                type="button"
                className="secondary-action"
                disabled={!model.canUseDirectRallar || !model.activeGroupId}
                onClick={() => void model.joinGroup()}
            >
                Join group
            </button>
            <button
                type="button"
                className="secondary-action"
                disabled={!model.subscription}
                onClick={model.unsubscribeWs}
            >
                Unsubscribe WS
            </button>
            <button type="button" className="secondary-action" onClick={model.copyDiagnostics}>
                Copy diagnostics
            </button>
            <button type="button" className="secondary-action" onClick={model.copyRunnerRecipe}>
                Copy runner recipe
            </button>
            {model.realBackendReady && (
                <button type="button" className="secondary-action" onClick={onOpenRunnerMode}>
                    Open runner mode
                </button>
            )}
        </div>
    );
}
