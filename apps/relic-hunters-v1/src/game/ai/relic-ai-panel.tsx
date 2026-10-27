import type {
    RelicActionInput,
    RelicPlanningAiSuggestion,
    RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { roomName, shortId } from '../lang.ts';
import type { RelicPlanningAiProposal } from './relic-planning-ai.ts';
import { type UseRelicPlanningAiResult } from './useRelicPlanningAi.ts';

interface RelicAiCompanionPanelProps {
    readonly state: UseRelicPlanningAiResult;
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    onAsk(): Promise<void>;
    onPrime(action: RelicActionInput): void;
}

export function RelicAiCompanionPanel({
    state,
    snapshot,
    localPlayerId,
    onAsk,
    onPrime
}: RelicAiCompanionPanelProps) {
    const proposal = state.proposals[0] ?? state.localProposal;
    const suggestion = proposal?.result.value;
    const canPrime = state.status === 'ready' && proposal?.local === true && !!suggestion?.action;

    return (
        <div id="hud-ai" className={`panel stack relic-ai-panel relic-ai-${state.status}`}>
            <div className="relic-ai-header">
                <div>
                    <span className="panel-label">AI Companion</span>
                    <strong>{relicAiStatusTitle(state.status)}</strong>
                </div>
                <button
                    type="button"
                    className="primary relic-ai-ask"
                    disabled={!state.canGenerate}
                    onClick={() => void onAsk()}
                >
                    {state.status === 'generating' ? 'Thinking' : 'Ask'}
                </button>
            </div>

            {state.error && <small className="relic-ai-error">{state.error}</small>}

            {suggestion
                ? (
                    <RelicAiSuggestionCard
                        proposal={proposal}
                        suggestion={suggestion}
                        snapshot={snapshot}
                        localPlayerId={localPlayerId}
                        showPrime={canPrime}
                        onPrime={onPrime}
                    />
                )
                : <small className="relic-ai-empty">{relicAiStatusDetail(state.status)}</small>}
        </div>
    );
}

interface RelicAiSuggestionCardProps {
    readonly proposal?: RelicPlanningAiProposal;
    readonly suggestion: RelicPlanningAiSuggestion;
    readonly snapshot: RelicPublicSnapshot;
    readonly localPlayerId?: string;
    readonly showPrime: boolean;
    onPrime(action: RelicActionInput): void;
}

export function RelicAiSuggestionCard({
    proposal,
    suggestion,
    snapshot,
    localPlayerId,
    showPrime,
    onPrime
}: RelicAiSuggestionCardProps) {
    const action = suggestion.action ? toRelicActionInput(suggestion.action) : undefined;
    return (
        <div className={`relic-ai-card${proposal?.local ? ' local' : ''}`}>
            <div className="relic-ai-card-head">
                <span>{proposalSenderLabel(proposal, snapshot, localPlayerId)}</span>
                <em>{suggestion.confidence}</em>
            </div>
            <strong>{suggestion.headline}</strong>
            {action && (
                <span className="relic-ai-action">
                    {relicAiActionLabel(action, snapshot)}
                </span>
            )}
            <small>{suggestion.rationale}</small>
            {suggestion.risks.length > 0 && (
                <div className="relic-ai-risks">
                    {suggestion.risks.map((risk) => <span key={risk}>{risk}</span>)}
                </div>
            )}
            {showPrime && action && (
                <button
                    type="button"
                    className="secondary relic-ai-prime"
                    onClick={() => onPrime(action)}
                >
                    Prime
                </button>
            )}
        </div>
    );
}

export function relicAiStatusTitle(status: UseRelicPlanningAiResult['status']): string {
    switch (status) {
        case 'disabled':
            return 'Quiet';
        case 'generating':
            return 'Reading the board';
        case 'ready':
            return 'Suggestion ready';
        case 'stale':
            return 'Turn changed';
        case 'error':
            return 'Needs another try';
        case 'unavailable':
            return 'Unavailable';
        case 'idle':
        default:
            return 'Planning lens';
    }
}

export function relicAiStatusDetail(status: UseRelicPlanningAiResult['status']): string {
    switch (status) {
        case 'disabled':
            return 'Companion notes appear while you can still choose a plan.';
        case 'generating':
            return 'Checking legal choices.';
        case 'stale':
            return 'Ask again after the current snapshot settles.';
        case 'error':
            return 'The last suggestion could not be used.';
        case 'unavailable':
            return 'No browser provider is configured.';
        case 'ready':
        case 'idle':
        default:
            return 'Ask for a legal suggestion for this turn.';
    }
}

export function proposalSenderLabel(
    proposal: RelicPlanningAiProposal | undefined,
    snapshot: RelicPublicSnapshot,
    localPlayerId: string | undefined
): string {
    if (!proposal || proposal.local || proposal.senderId === localPlayerId) {
        return 'You';
    }
    const player = snapshot.players.find((candidate) => candidate.playerId === proposal.senderId);
    return player?.username ?? (proposal.senderId ? shortId(proposal.senderId) : 'Hunter');
}

export function relicAiActionLabel(
    action: RelicActionInput,
    snapshot: RelicPublicSnapshot
): string {
    if (action.kind === 'move') {
        return `Move to ${roomName(snapshot, action.targetRoomId ?? '')}`;
    }
    if (action.kind === 'steal') {
        const target = snapshot.players.find((player) => player.playerId === action.targetPlayerId);
        return `Steal from ${target?.username ?? 'hunter'}`;
    }
    if (action.kind === 'escape') {
        return 'Escape';
    }
    return 'Search';
}

export function toRelicActionInput(
    action: RelicPlanningAiSuggestion['action']
): RelicActionInput {
    if (action?.kind === 'move') {
        return { kind: 'move', targetRoomId: action.targetRoomId };
    }
    if (action?.kind === 'steal') {
        return { kind: 'steal', targetPlayerId: action.targetPlayerId };
    }
    return { kind: action?.kind ?? 'search' };
}
