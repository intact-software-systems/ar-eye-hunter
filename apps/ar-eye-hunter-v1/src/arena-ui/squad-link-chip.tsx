import type { ArenaConnection } from '../game/arena-runtime/arena-connection-contracts.ts';
interface SquadLinkChipProps {
    readonly linkState: ArenaConnection['linkState'];
    readonly open: boolean;
    readonly onToggle: () => void;
    readonly onOpenDiagnostics: () => void;
    readonly directorLabel: string;
}
interface PresenceToastStackProps {
    readonly notices: ArenaConnection['presenceNotices'];
    readonly onDismiss: (id: string) => void;
}
export function SquadLinkChip({
    linkState,
    open,
    onToggle,
    onOpenDiagnostics,
    directorLabel
}: SquadLinkChipProps) {
    return (
        <div className="squad-link" data-tone={linkState.tone}>
            <button
                type="button"
                className="squad-link__button"
                aria-expanded={open}
                onClick={onToggle}
            >
                <span>Squad Link</span>
                <strong>{linkState.label}</strong>
            </button>
            {open && (
                <div className="squad-link__popover">
                    <strong>{linkState.detail}</strong>
                    <span>
                        {linkState.playerCount} hunter{linkState.playerCount === 1 ? '' : 's'} in this signal mess.
                    </span>
                    <span>Arena host: {directorLabel}</span>
                    <button type="button" onClick={onOpenDiagnostics}>
                        Open diagnostics
                    </button>
                </div>
            )}
        </div>
    );
}

export function PresenceToastStack({
    notices,
    onDismiss
}: PresenceToastStackProps) {
    if (notices.length === 0) {
        return null;
    }
    return (
        <div className="presence-toasts" aria-live="polite" aria-label="Squad link updates">
            {notices.slice(-4).map((notice) => (
                <button
                    type="button"
                    key={notice.id}
                    className="presence-toast"
                    data-kind={notice.kind}
                    onClick={() => onDismiss(notice.id)}
                >
                    <span>{notice.message}</span>
                </button>
            ))}
        </div>
    );
}
