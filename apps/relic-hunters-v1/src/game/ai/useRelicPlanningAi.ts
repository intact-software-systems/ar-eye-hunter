import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';
import {
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicPublicSnapshot,
} from '@relic-hunters/mod.ts';
import {
    type RallarAiDiagnosticEvent,
    type RallarAiJsonProvider,
    type RallarAiJsonResult,
    transitionRallarAiResultLifecycle,
} from '@shared/rallar-ai/mod.ts';
import { createRallarBrowserAi } from '@shared-web/browser/rallar-ai.ts';
import { rallar, type RallarMessage } from '@shared-web/browser/rallar.ts';
import type { ActionDraft, RelicGameViewModel } from '../game-view-model.ts';
import type { Lang } from '../lang.ts';
import type { SceneObjective } from '../scene/objectives.ts';
import {
    addRelicPlanningAiProposal,
    buildRelicPlanningAiContext,
    canGenerateRelicPlanningAi,
    createRelicPlanningAiMockProvider,
    createRelicPlanningAiRequest,
    isRelicPlanningAiRevisionCurrent,
    pruneRelicPlanningAiProposals,
    relicPlanningAiBaseStateRevision,
    relicPlanningAiDedupeKey,
    type RelicPlanningAiContext,
    type RelicPlanningAiProposal,
    type RelicPlanningAiState,
    type RelicPlanningAiStatus,
    type RelicPlanningAiSuggestion,
    validateRelicPlanningAiSuggestion,
} from './relic-planning-ai.ts';

export type UseRelicPlanningAiInput = Readonly<{
    snapshot?: RelicPublicSnapshot;
    localPlayerId?: string;
    draft: ActionDraft;
    lang: Lang;
    viewModel: RelicGameViewModel;
    sceneObjective?: SceneObjective;
    provider?: RallarAiJsonProvider;
    enabled?: boolean;
    now?: () => number;
    diagnostics?: (event: RallarAiDiagnosticEvent) => void;
}>;

export type UseRelicPlanningAiResult = RelicPlanningAiState & Readonly<{
    ask(): Promise<void>;
}>;

const BROWSER_AI_POLICY = {
    mode: 'browser-only',
    staleResultMode: 'reject',
    timeoutMs: 5_000,
} as const;

export function useRelicPlanningAi({
    snapshot,
    localPlayerId,
    draft,
    lang,
    viewModel,
    sceneObjective,
    provider,
    enabled = true,
    now = () => Date.now(),
    diagnostics,
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
            sceneObjective,
        });
    }, [canAsk, draft, lang, localPlayerId, sceneObjective, snapshot, viewModel]);
    const baseStateRevision = useMemo(() =>
        snapshot
            ? relicPlanningAiBaseStateRevision({ snapshot, localPlayerId, draft })
            : undefined,
        [draft, localPlayerId, snapshot],
    );
    const dedupeKey = useMemo(() =>
        snapshot && baseStateRevision
            ? relicPlanningAiDedupeKey({ snapshot, localPlayerId, baseStateRevision })
            : undefined,
        [baseStateRevision, localPlayerId, snapshot],
    );
    const defaultProvider = useMemo(() =>
        provider ?? (defaultBrowserAiProviderEnabled() ? createRelicPlanningAiMockProvider() : undefined),
        [provider],
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
                'exact',
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
                    'shared',
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
                    'exact',
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
                typeId: RELIC_TYPES.aiPlanningProposal,
            },
            (message) => {
                acceptRemoteProposal(message, {
                    currentBaseStateRevision: revisionRef.current,
                    currentRoomId: roomIdRef.current,
                    setProposals,
                });
            },
        );
    }, [snapshot?.roomId]);

    useEffect(() => () => {
        abortRef.current?.abort();
    }, []);

    const ask = useCallback(async () => {
        const currentContext = contextRef.current;
        const currentRevision = revisionRef.current;
        const currentRoomId = roomIdRef.current;
        if (!enabled || !currentContext || !currentRevision || !dedupeKey || !snapshot) {
            setStatus('disabled');
            return;
        }
        if (!defaultProvider) {
            setStatus('unavailable');
            setError('Browser AI is not configured for this build.');
            return;
        }

        abortRef.current?.abort();
        const abort = new AbortController();
        abortRef.current = abort;
        setStatus('generating');
        setError(undefined);

        const ai = createRallarBrowserAi({
            rallar,
            provider: defaultProvider,
            policy: BROWSER_AI_POLICY,
            diagnostics,
            readCurrentStateRevision: () => revisionRef.current,
        });

        try {
            const draftResult = await ai.generateJson<
                RelicPlanningAiSuggestion,
                RelicPlanningAiContext
            >(createRelicPlanningAiRequest({
                context: currentContext,
                baseStateRevision: currentRevision,
                dedupeKey,
                signal: abort.signal,
            }));
            if (
                !isRelicPlanningAiRevisionCurrent(
                    draftResult.baseStateRevision,
                    revisionRef.current ?? '',
                    'exact',
                )
            ) {
                setStatus('stale');
                return;
            }

            const validation = validateRelicPlanningAiSuggestion(
                draftResult.value,
                contextRef.current ?? currentContext,
            );
            if (!validation.ok) {
                setStatus('error');
                setError(validation.reason);
                return;
            }

            const proposed = transitionRallarAiResultLifecycle({
                ...draftResult,
                value: validation.suggestion,
            }, 'proposed');
            const proposal: RelicPlanningAiProposal = {
                result: proposed,
                senderId: localPlayerId,
                receivedAtEpochMs: nowRef.current(),
                local: true,
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
                    revisionMode: 'exact',
                })
            );
            setStatus('ready');

            await ai.broadcastJson({
                result: proposed,
                transport: 'messages.ws',
                roomId: currentRoomId,
                topicId: RELIC_TOPICS.aiPlanning,
                typeId: RELIC_TYPES.aiPlanningProposal,
            });
        } catch (err) {
            if (abort.signal.aborted) {
                return;
            }
            setStatus('error');
            setError(toErrorMessage(err));
        } finally {
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
        snapshot,
    ]);

    const visibleStatus = deriveVisibleStatus({
        canAsk,
        provider: defaultProvider,
        status,
        localProposal,
        baseStateRevision,
    });

    return {
        status: visibleStatus,
        canGenerate: canAsk && !!defaultProvider && visibleStatus !== 'generating',
        error,
        localProposal,
        proposals,
        ask,
    };
}

function acceptRemoteProposal(
    message: RallarMessage<RallarAiJsonResult<RelicPlanningAiSuggestion>>,
    options: Readonly<{
        currentBaseStateRevision?: string;
        currentRoomId?: string;
        setProposals: Dispatch<SetStateAction<readonly RelicPlanningAiProposal[]>>;
    }>,
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
            revisionMode: 'shared',
        })
    );
}

function deriveVisibleStatus({
    canAsk,
    provider,
    status,
    localProposal,
    baseStateRevision,
}: Readonly<{
    canAsk: boolean;
    provider?: RallarAiJsonProvider;
    status: RelicPlanningAiStatus;
    localProposal?: RelicPlanningAiProposal;
    baseStateRevision?: string;
}>): RelicPlanningAiStatus {
    if (!canAsk) {
        return 'disabled';
    }
    if (!provider) {
        return 'unavailable';
    }
    if (
        localProposal &&
        baseStateRevision &&
        !isRelicPlanningAiRevisionCurrent(
            localProposal.result.baseStateRevision,
            baseStateRevision,
            'exact',
        )
    ) {
        return 'stale';
    }
    return status;
}

function defaultBrowserAiProviderEnabled(): boolean {
    const env = (import.meta as {
        env?: Readonly<{ DEV?: boolean; MODE?: string; VITEST?: string }>;
    }).env;
    const processEnv = (globalThis as {
        process?: { env?: Readonly<Record<string, string | undefined>> };
    }).process?.env;
    return !!env?.DEV ||
        env?.MODE === 'test' ||
        !!env?.VITEST ||
        !!processEnv?.VITEST;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
