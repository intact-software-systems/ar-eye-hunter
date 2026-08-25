import { useEffect, useRef, useState, type MutableRefObject, type SetStateAction } from 'react';
import type { DirectRallarOperationResult } from '../../direct-rallar-operations.ts';
import type {
    QuickRallarReceivedMessageRow,
    QuickRallarSubscriptionState,
    QuickRallarValues
} from './quick-rallar-contracts.ts';
import { quickRallarDefaults } from './quick-rallar-defaults.ts';

export interface UseQuickRallarTestValuesInput {
    readonly groupId: string;
    onGroupIdChange(groupId: string): void;
}

export interface QuickRallarTestValuesState {
    readonly values: QuickRallarValues;
    updateValue<K extends keyof QuickRallarValues>(
        key: K,
        value: QuickRallarValues[K]
    ): void;
    updateGroupId(groupId: string): void;
}

export interface QuickRallarTestRuntimeState {
    readonly busyAction?: string;
    readonly localError?: string;
    readonly lastResult?: DirectRallarOperationResult;
    readonly subscription?: QuickRallarSubscriptionState;
    readonly receivedMessages: readonly QuickRallarReceivedMessageRow[];
    readonly waitStatus: string;
    readonly subscriptionRef: MutableRefObject<QuickRallarSubscriptionState | undefined>;
    readonly receivedCountRef: MutableRefObject<number>;
    setBusyAction(busyAction: string | undefined): void;
    setLocalError(localError: string | undefined): void;
    setLastResult(result: DirectRallarOperationResult | undefined): void;
    setSubscription(subscription: QuickRallarSubscriptionState | undefined): void;
    setReceivedMessages(
        receivedMessages: SetStateAction<readonly QuickRallarReceivedMessageRow[]>
    ): void;
    setWaitStatus(waitStatus: string): void;
}

export function useQuickRallarTestValues({
    groupId,
    onGroupIdChange
}: UseQuickRallarTestValuesInput): QuickRallarTestValuesState {
    const [values, setValues] = useState<QuickRallarValues>(() => ({
        ...quickRallarDefaults,
        contextId: groupId || 'room'
    }));
    const previousGroupIdRef = useRef(groupId);

    useEffect(() => {
        const previousGroupId = previousGroupIdRef.current;
        previousGroupIdRef.current = groupId;
        setValues((current) => toQuickRallarValuesForGroup(current, previousGroupId, groupId));
    }, [groupId]);

    return {
        values,
        updateValue: (key, value) => {
            setValues((current) => ({ ...current, [key]: value }));
        },
        updateGroupId: (nextGroupId) => {
            onGroupIdChange(nextGroupId);
            setValues((current) => toQuickRallarValuesForGroup(current, groupId, nextGroupId));
        }
    };
}

export function useQuickRallarTestRuntimeState(): QuickRallarTestRuntimeState {
    const [busyAction, setBusyAction] = useState<string | undefined>();
    const [localError, setLocalError] = useState<string | undefined>();
    const [lastResult, setLastResult] = useState<DirectRallarOperationResult | undefined>();
    const [subscription, setSubscription] = useState<QuickRallarSubscriptionState | undefined>();
    const [receivedMessages, setReceivedMessages] = useState<readonly QuickRallarReceivedMessageRow[]>([]);
    const [waitStatus, setWaitStatus] = useState('idle');
    const subscriptionRef = useRef<QuickRallarSubscriptionState | undefined>(undefined);
    const receivedCountRef = useRef(0);

    useEffect(() => {
        subscriptionRef.current = subscription;
    }, [subscription]);

    useEffect(() => {
        receivedCountRef.current = receivedMessages.length;
    }, [receivedMessages.length]);

    useEffect(() => () => subscriptionRef.current?.unsubscribe(), []);

    return {
        busyAction,
        localError,
        lastResult,
        subscription,
        receivedMessages,
        waitStatus,
        subscriptionRef,
        receivedCountRef,
        setBusyAction,
        setLocalError,
        setLastResult,
        setSubscription,
        setReceivedMessages,
        setWaitStatus
    };
}

function toQuickRallarValuesForGroup(
    values: QuickRallarValues,
    previousGroupId: string,
    nextGroupId: string
): QuickRallarValues {
    if (values.contextId && values.contextId !== previousGroupId) {
        return values;
    }

    return {
        ...values,
        contextId: nextGroupId || 'room'
    };
}
