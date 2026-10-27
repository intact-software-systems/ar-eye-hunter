import {
    decodeRelicPlanningAiSuggestion,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicPlanningAiContext,
    type RelicPlanningAiSuggestion,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';
import { rallar, type RallarMessage } from '@shared-web/browser/rallar.ts';
import {
    transitionRallarAiResultLifecycle,
    type RallarAiDiagnosticEvent,
    type RallarAiJsonProvider,
    type RallarAiJsonResult
} from '@shared/rallar-ai/mod.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ActionDraft, RelicGameViewModel } from '../game-view-model.ts';
import type { Lang } from '../lang.ts';
import type { SceneObjective } from '../scene/objectives.ts';
import { createDefaultRelicPlanningAiProvider } from './create-default-relic-planning-ai-provider.ts';
import { isRelicPlanningAiProposalOfPrincipal } from './is-relic-planning-ai-proposal-of-principal.ts';
import {
    addRelicPlanningAiProposal,
    buildRelicPlanningAiContext,
    canGenerateRelicPlanningAi,
    createRelicPlanningAiRequest,
    isRelicPlanningAiRevisionCurrent,
    pruneRelicPlanningAiProposals,
    relicPlanningAiBaseStateRevision,
    relicPlanningAiDedupeKey,
    type RelicPlanningAiProposal,
    type RelicPlanningAiRequest,
    type RelicPlanningAiState,
    type RelicPlanningAiStatus
} from './relic-planning-ai.ts';
import { sendRelicPlanningRequest } from './send-relic-planning-request.ts';

export type UseRelicPlanningAiInput = Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    /** The signed-in hunter's principal: a suggestion reaches that principal's sessions in the room only. */
    localPrincipalId?: string;
    draft: ActionDraft;
    lang: Lang;
    viewModel: RelicGameViewModel;
    sceneObjective?: SceneObjective;
    provider?: RallarAiJsonProvider;
    enabled?: boolean;
    now?: () => number;
    /** Local generation only: the server request and the proposal send to the hunter's sessions emit none. */
    diagnostics?: (event: RallarAiDiagnosticEvent) => void;
}>;

export type UseRelicPlanningAiResult =
    & RelicPlanningAiState
    & Readonly<{
        ask(): Promise<void>;
    }>;

const BROWSER_AI_POLICY = {
    mode: 'browser-only',
    staleResultMode: 'reject',
    timeoutMs: 5_000
} as const;

export function useRelicPlanningAi({
    snapshot,
    localPlayerId,
    localPrincipalId,
    draft,
    lang,
    viewModel,
    sceneObjective,
    provider,
    enabled = true,
    now = () => Date.now(),
    diagnostics
}: UseRelicPlanningAiInput): UseRelicPlanningAiResult {
    const canAsk = enabled && canGenerateRelicPlanningAi(snapshot, localPlayerId);
    const context = useMemo(() => {
        if (!snapshot || !canAsk) {
            return undefined;
        }
        return buildRelicPlanningAiContext({
            snapshot,
            localPlayerId,
            draft,
            lang,
            viewModel,
            sceneObjective
        });
    }, [canAsk, draft, lang, localPlayerId, sceneObjective, snapshot, viewModel]);
    const baseStateRevision = useMemo(() =>
        snapshot
            ? relicPlanningAiBaseStateRevision({ snapshot, localPlayerId, draft })
            : undefined, [draft, localPlayerId, snapshot]);
    const dedupeKey = useMemo(() =>
        snapshot && baseStateRevision
            ? relicPlanningAiDedupeKey({ snapshot, localPlayerId, baseStateRevision })
            : undefined, [baseStateRevision, localPlayerId, snapshot]);
    const defaultProvider = useMemo(
        () => provider ?? createDefaultRelicPlanningAiProvider(),
        [provider]
    );

    const [status, setStatus] = useState<RelicPlanningAiStatus>('idle');
    const [error, setError] = useState<string | undefined>();
    const [localProposal, setLocalProposal] = useState<RelicPlanningAiProposal | undefined>();
    const [proposals, setProposals] = useState<readonly RelicPlanningAiProposal[]>([]);
    const abortRef = useRef<AbortController | undefined>(undefined);
    const contextRef = useRef<RelicPlanningAiContext | undefined>(context);
    const revisionRef = useRef<string | undefined>(baseStateRevision);
    const roomIdRef = useRef<string | undefined>(snapshot?.roomId);
    const nowRef = useRef(now);

    useEffect(() => {
        contextRef.current = context;
        revisionRef.current = baseStateRevision;
        roomIdRef.current = snapshot?.roomId;
        nowRef.current = now;
    }, [baseStateRevision, context, snapshot?.roomId, now]);

    useEffect(() => {
        if (!baseStateRevision) {
            setLocalProposal(undefined);
            setProposals([]);
            setStatus('idle');
            return;
        }

        setLocalProposal((current) => {
            if (!current) {
                return current;
            }
            return isRelicPlanningAiRevisionCurrent(
                    current.result.baseStateRevision,
                    baseStateRevision,
                    'exact'
                )
                ? current
                : current;
        });
        setProposals((current) =>
            pruneRelicPlanningAiProposals(current, nowRef.current()).filter((proposal) =>
                proposal.local ||
                isRelicPlanningAiRevisionCurrent(
                    proposal.result.baseStateRevision,
                    baseStateRevision,
                    'shared'
                )
            )
        );
        setStatus((current) => {
            if (
                current === 'ready' &&
                localProposal &&
                !isRelicPlanningAiRevisionCurrent(
                    localProposal.result.baseStateRevision,
                    baseStateRevision,
                    'exact'
                )
            ) {
                return 'stale';
            }
            return current === 'disabled' || current === 'unavailable' ? 'idle' : current;
        });
    }, [baseStateRevision, localProposal]);

    useEffect(() => {
        if (!snapshot?.roomId) {
            return;
        }
        return rallar.messages.ws.onMessage<RallarAiJsonResult<RelicPlanningAiSuggestion>>(
            {
                topicId: RELIC_TOPICS.aiPlanning,
                typeId: RELIC_TYPES.aiPlanningProposal
            },
            (message) => {
                if (!isRelicPlanningAiProposalOfPrincipal(message.raw, localPrincipalId)) {
                    return;
                }
                acceptRemoteProposal(message, {
                    currentBaseStateRevision: revisionRef.current,
                    currentRoomId: roomIdRef.current,
                    setProposals
                });
            }
        );
    }, [snapshot?.roomId, localPrincipalId]);

    useEffect(() => () => {
        abortRef.current?.abort();
    }, []);

    const ask = useCallback(async () => {
        const currentContext = contextRef.current;
        const currentRevision = revisionRef.current;
        const currentRoomId = roomIdRef.current;
        if (
            !enabled || !currentContext || !currentRevision || !dedupeKey || !snapshot || !currentRoomId ||
            !localPrincipalId
        ) {
            setStatus('disabled');
            return;
        }
        if (rallar.serverPeerId() === undefined && !defaultProvider) {
            setStatus('unavailable');
            setError('Browser AI is not configured for this build.');
            return;
        }

        abortRef.current?.abort();
        const abort = new AbortController();
        abortRef.current = abort;
        setStatus('generating');
        setError(undefined);

        try {
            const suggestion = await readRelicPlanningSuggestion({
                request: createRelicPlanningAiRequest({
                    context: currentContext,
                    baseStateRevision: currentRevision,
                    dedupeKey
                }),
                context: currentContext,
                roomId: currentRoomId,
                provider: defaultProvider,
                diagnostics,
                readCurrentContext: () => contextRef.current ?? currentContext,
                readCurrentRevision: () => revisionRef.current,
                signal: abort.signal
            });
            if (abort.signal.aborted || suggestion.kind === 'aborted') {
                return;
            }
            if (suggestion.kind !== 'suggested') {
                setStatus(suggestion.kind === 'invalid' ? 'error' : suggestion.kind);
                setError(suggestion.kind === 'invalid' ? suggestion.reason : undefined);
                return;
            }

            const proposed = transitionRallarAiResultLifecycle(suggestion.result, 'proposed');
            const proposal: RelicPlanningAiProposal = {
                result: proposed,
                senderId: localPlayerId,
                receivedAtEpochMs: nowRef.current(),
                local: true
            };
            setLocalProposal(proposal);
            setProposals((current) =>
                addRelicPlanningAiProposal({
                    proposals: current,
                    result: proposed,
                    senderId: localPlayerId,
                    receivedAtEpochMs: proposal.receivedAtEpochMs,
                    local: true,
                    currentBaseStateRevision: currentRevision,
                    revisionMode: 'exact'
                })
            );
            setStatus('ready');
            await sendRelicPlanningProposalToOwnSessions(proposed, currentRoomId, localPrincipalId);
        }
        catch (err) {
            if (abort.signal.aborted) {
                return;
            }
            setStatus('error');
            setError(toError(err).message);
        }
        finally {
            if (abortRef.current === abort) {
                abortRef.current = undefined;
            }
        }
    }, [
        dedupeKey,
        defaultProvider,
        diagnostics,
        enabled,
        localPlayerId,
        localPrincipalId,
        snapshot
    ]);

    const canAnswer = !!defaultProvider || rallar.serverPeerId() !== undefined;
    const visibleStatus = deriveVisibleStatus({
        canAsk,
        canAnswer,
        status,
        localProposal,
        baseStateRevision
    });

    return {
        status: visibleStatus,
        canGenerate: canAsk && canAnswer && visibleStatus !== 'generating',
        error,
        localProposal,
        proposals,
        ask
    };
}

function acceptRemoteProposal(
    message: RallarMessage<RallarAiJsonResult<RelicPlanningAiSuggestion>>,
    options: Readonly<{
        currentBaseStateRevision?: string;
        currentRoomId?: string;
        setProposals: Dispatch<SetStateAction<readonly RelicPlanningAiProposal[]>>;
    }>
): void {
    options.setProposals((current) =>
        addRelicPlanningAiProposal({
            proposals: current,
            result: message.payload,
            senderId: message.senderId,
            receivedAtEpochMs: message.receivedAtEpochMs,
            local: false,
            messageRoomId: message.roomId,
            currentRoomId: options.currentRoomId,
            currentBaseStateRevision: options.currentBaseStateRevision,
            revisionMode: 'shared'
        })
    );
}

interface ReadRelicPlanningSuggestionInput {
    readonly request: RelicPlanningAiRequest;
    readonly context: RelicPlanningAiContext;
    readonly roomId: string;
    readonly provider: RallarAiJsonProvider | undefined;
    readonly diagnostics: UseRelicPlanningAiInput['diagnostics'];
    readonly readCurrentContext: () => RelicPlanningAiContext;
    readonly readCurrentRevision: () => string | undefined;
    readonly signal: AbortSignal;
}

type RelicPlanningSuggestionOutcome =
    | Readonly<{ kind: 'suggested'; result: RallarAiJsonResult<RelicPlanningAiSuggestion>; }>
    | Readonly<{ kind: 'aborted' | 'stale' | 'unavailable'; }>
    | Readonly<{ kind: 'invalid'; reason: string; }>;

async function readRelicPlanningSuggestion(
    input: ReadRelicPlanningSuggestionInput
): Promise<RelicPlanningSuggestionOutcome> {
    const answered = await sendRelicPlanningRequest(rallar, {
        roomId: input.roomId,
        request: input.request,
        context: input.context,
        currentBaseStateRevision: input.readCurrentRevision,
        signal: input.signal
    });
    if (answered.right !== undefined) {
        return { kind: 'suggested', result: answered.right };
    }
    if (answered.left === 'aborted') {
        return { kind: 'aborted' };
    }
    return input.provider === undefined
        ? { kind: 'unavailable' }
        : await readLocalRelicPlanningSuggestion(input, input.provider);
}

async function readLocalRelicPlanningSuggestion(
    input: ReadRelicPlanningSuggestionInput,
    provider: RallarAiJsonProvider
): Promise<RelicPlanningSuggestionOutcome> {
    const ai = createRallarBrowserAi({
        rallar,
        provider,
        policy: BROWSER_AI_POLICY,
        diagnostics: input.diagnostics,
        readCurrentStateRevision: input.readCurrentRevision
    });
    const draftResult = await ai.generateJson<RelicPlanningAiSuggestion, RelicPlanningAiContext>({
        ...input.request,
        signal: input.signal
    });
    if (!isRelicPlanningAiRevisionCurrent(draftResult.baseStateRevision, input.readCurrentRevision() ?? '', 'exact')) {
        return { kind: 'stale' };
    }
    const suggestion = decodeRelicPlanningAiSuggestion(draftResult.value, input.readCurrentContext());
    return suggestion.right === undefined
        ? { kind: 'invalid', reason: suggestion.left! }
        : { kind: 'suggested', result: { ...draftResult, value: suggestion.right } };
}

/** The hunter's other sessions in the room see the suggestion read-only; none of them may submit it. */
async function sendRelicPlanningProposalToOwnSessions(
    result: RallarAiJsonResult<RelicPlanningAiSuggestion>,
    roomId: string,
    principalId: string
): Promise<void> {
    await rallar.messages.ws.send({
        topicId: RELIC_TOPICS.aiPlanning,
        typeId: RELIC_TYPES.aiPlanningProposal,
        payload: result,
        roomId,
        scope: 'principal',
        principalId
    });
}

function deriveVisibleStatus({
    canAsk,
    canAnswer,
    status,
    localProposal,
    baseStateRevision
}: Readonly<{
    canAsk: boolean;
    canAnswer: boolean;
    status: RelicPlanningAiStatus;
    localProposal?: RelicPlanningAiProposal;
    baseStateRevision?: string;
}>): RelicPlanningAiStatus {
    if (!canAsk) {
        return 'disabled';
    }
    if (!canAnswer) {
        return 'unavailable';
    }
    if (
        localProposal &&
        baseStateRevision &&
        !isRelicPlanningAiRevisionCurrent(
            localProposal.result.baseStateRevision,
            baseStateRevision,
            'exact'
        )
    ) {
        return 'stale';
    }
    return status;
}
