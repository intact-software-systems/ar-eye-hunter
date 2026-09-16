import type { RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../../../client-defaults.ts';
import type { RallarBlackBoxBootstrapConfig } from '../../../runtime-store.ts';
import { json, splitCsvValues } from '../../shared/json-presentation.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import { idleActionFeedback, type CommandCenterActionFeedback } from '../shared/action-feedback.ts';
import { RtcRealtimeActions } from './rtc-realtime-actions.ts';
import type {
    RtcRealtimeActivity,
    RtcRealtimeFormSetters,
    RtcRealtimeFormValues,
    RtcRealtimeOperations,
    RtcRealtimeReceivedRow,
    RtcRealtimeSubscriptionRow,
    RtcRealtimeViewModel
} from './rtc-realtime-contracts.ts';
import { RtcRealtimeFacadeSession } from './rtc-realtime-facade-session.ts';

export interface UseRtcRealtimeControllerInput {
    readonly state: RallarBlackBoxTestState;
    readonly bootstrap: RallarBlackBoxBootstrapConfig;
    readonly authSession: AuthSession | undefined;
    readonly globalValues: CommandCenterGlobalValues;
}

interface RtcRealtimeForm {
    readonly values: RtcRealtimeFormValues;
    update<K extends keyof RtcRealtimeFormValues>(key: K): (value: RtcRealtimeFormValues[K]) => void;
}

interface RtcRealtimeControls {
    readonly busyAction: string | undefined;
    readonly setBusyAction: React.Dispatch<React.SetStateAction<string | undefined>>;
    readonly localError: string | undefined;
    readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
    readonly actionFeedback: CommandCenterActionFeedback;
    readonly setActionFeedback: React.Dispatch<React.SetStateAction<CommandCenterActionFeedback>>;
    readonly result: RtcRealtimeActivity['result'];
    readonly setResult: React.Dispatch<React.SetStateAction<RtcRealtimeActivity['result']>>;
    readonly received: readonly RtcRealtimeReceivedRow[];
    readonly setReceived: React.Dispatch<React.SetStateAction<readonly RtcRealtimeReceivedRow[]>>;
    readonly health: RtcRealtimeActivity['health'];
    readonly setHealth: React.Dispatch<React.SetStateAction<RtcRealtimeActivity['health']>>;
    readonly subscriptions: readonly RtcRealtimeSubscriptionRow[];
    readonly setSubscriptions: React.Dispatch<React.SetStateAction<readonly RtcRealtimeSubscriptionRow[]>>;
    readonly subscriptionsRef: React.RefObject<readonly RtcRealtimeSubscriptionRow[]>;
}

export function useRtcRealtimeController(input: UseRtcRealtimeControllerInput): RtcRealtimeViewModel {
    const { bootstrap, authSession, globalValues } = input;
    const form = useRtcRealtimeForm(globalValues.roomId);
    const controls = useRtcRealtimeControls();
    const session = new RtcRealtimeFacadeSession({
        providerMode: bootstrap.providerMode,
        authSession,
        actor: authSession?.username ?? authSession?.clientId ?? bootstrap.actor,
        globalValues,
        transport: form.values.transport,
        timeoutMs: form.values.timeoutMs
    });
    const actions = new RtcRealtimeActions({ ...input, ...controls, form: form.values, session });
    return {
        ...form.values,
        ...toRtcRealtimeFormSetters(form),
        ...toRtcRealtimeActivity(input, form.values, controls),
        ...toRtcRealtimeOperations(actions)
    };
}

function useRtcRealtimeForm(roomId: string): RtcRealtimeForm {
    const [values, setValues] = useState(() => toInitialRtcRealtimeFormValues(roomId));
    useEffect(() => {
        setValues((current) => {
            const contextId = current.contextId && current.contextId !== 'room' ? current.contextId : roomId || 'room';
            return contextId === current.contextId ? current : { ...current, contextId };
        });
    }, [roomId]);
    return {
        values,
        update: (key) => (value) => setValues((current) => ({ ...current, [key]: value }))
    };
}

function useRtcRealtimeControls(): RtcRealtimeControls {
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [actionFeedback, setActionFeedback] = useState<CommandCenterActionFeedback>(() =>
        idleActionFeedback('Run an RTC/Realtimes operation to see action status.')
    );
    const [result, setResult] = useState<RtcRealtimeActivity['result']>();
    const [received, setReceived] = useState<readonly RtcRealtimeReceivedRow[]>([]);
    const [health, setHealth] = useState<RtcRealtimeActivity['health']>();
    const [subscriptions, setSubscriptions] = useState<readonly RtcRealtimeSubscriptionRow[]>([]);
    const subscriptionsRef = useRef<readonly RtcRealtimeSubscriptionRow[]>([]);
    useEffect(() => () => {
        subscriptionsRef.current.forEach((subscription) => subscription.unsubscribe());
        subscriptionsRef.current = [];
    }, []);
    return {
        busyAction,
        setBusyAction,
        localError,
        setLocalError,
        actionFeedback,
        setActionFeedback,
        result,
        setResult,
        received,
        setReceived,
        health,
        setHealth,
        subscriptions,
        setSubscriptions,
        subscriptionsRef
    };
}

function toInitialRtcRealtimeFormValues(roomId: string): RtcRealtimeFormValues {
    return {
        transport: 'realtime',
        laneId: 'realtime',
        peerIdsText: '',
        typeId: 'room.manual.message',
        topicId: 'room.manual.message',
        contextId: roomId || 'room',
        payloadText: json({ text: 'hello from direct RTC/Realtimes', seq: 1 }),
        minSnapshotVersion: '',
        reliability: 'best-effort',
        ack: 'none',
        ownership: 'shared',
        timeoutMs: RALLAR_BLACK_BOX_CLIENT_DEFAULTS.timeoutMs
    };
}

function toRtcRealtimeFormSetters({ update }: RtcRealtimeForm): RtcRealtimeFormSetters {
    return {
        setTransport: update('transport'),
        setLaneId: update('laneId'),
        setPeerIdsText: update('peerIdsText'),
        setTypeId: update('typeId'),
        setTopicId: update('topicId'),
        setContextId: update('contextId'),
        setPayloadText: update('payloadText'),
        setMinSnapshotVersion: update('minSnapshotVersion'),
        setReliability: update('reliability'),
        setAck: update('ack'),
        setOwnership: update('ownership'),
        setTimeoutMs: update('timeoutMs')
    };
}

function toRtcRealtimeActivity(
    { bootstrap, authSession, globalValues }: UseRtcRealtimeControllerInput,
    form: RtcRealtimeFormValues,
    controls: RtcRealtimeControls
): RtcRealtimeActivity {
    const realBackendReady = bootstrap.providerMode === 'browser-rallar';
    return {
        busyAction: controls.busyAction,
        localError: controls.localError,
        actionFeedback: controls.actionFeedback,
        result: controls.result,
        received: controls.received,
        health: controls.health,
        subscriptions: controls.subscriptions,
        providerMode: bootstrap.providerMode,
        realBackendReady,
        activeGroupId: globalValues.roomId.trim(),
        peerIds: splitCsvValues(form.peerIdsText),
        canRun: realBackendReady && Boolean(authSession) && !controls.busyAction
    };
}

function toRtcRealtimeOperations(actions: RtcRealtimeActions): RtcRealtimeOperations {
    return {
        subscribeRealtime: actions.subscribeRealtime,
        subscribeRtcMessages: actions.subscribeRtcMessages,
        clearSubscriptions: actions.clearSubscriptions,
        sendRealtime: actions.sendRealtime,
        sendRtcMessage: actions.sendRtcMessage,
        waitForRoomLane: actions.waitForRoomLane,
        refreshHealth: actions.refreshHealth,
        copyRecipe: actions.copyRecipe
    };
}
