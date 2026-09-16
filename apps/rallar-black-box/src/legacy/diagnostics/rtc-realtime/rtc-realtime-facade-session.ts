import type {
    RallarBlackBoxTestRuntimeEventInput,
    RallarBlackBoxTestSeverity
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarBlackBoxProviderMode } from '../../../client-defaults.ts';
import {
    configureDirectRallarFacade,
    createDirectRallarRuntimeEvent,
    type DirectRallarOperationContext
} from '../../../direct-rallar-operations.ts';
import { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { loadBrowserRallarFacade } from '../../rallar/load-browser-rallar-facade.ts';
import { recordArray, recordValue } from '../../shared/record-value.ts';
import { stringValue } from '../../shared/string-value.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RtcRealtimeTransport } from './rtc-realtime-contracts.ts';

export namespace RtcRealtimeFacadeSession {
    export interface Input {
        readonly providerMode: RallarBlackBoxProviderMode;
        readonly authSession: AuthSession | undefined;
        readonly actor: string;
        readonly globalValues: CommandCenterGlobalValues;
        readonly transport: RtcRealtimeTransport;
        readonly timeoutMs: number;
    }

    export interface Event {
        readonly topic: string;
        readonly severity: RallarBlackBoxTestSeverity;
        readonly payload: RallarBlackBoxTestRuntimeEventInput['payload'];
        readonly lastAction: string | undefined;
    }

    export type PhaseDetails = Readonly<Record<string, string | number>>;
}

/** Every RTC/Realtimes operation loads, configures and starts the browser facade and joins the active group first. */
export class RtcRealtimeFacadeSession {
    private readonly input: RtcRealtimeFacadeSession.Input;
    private readonly activeGroupId: string;

    constructor(input: RtcRealtimeFacadeSession.Input) {
        this.input = input;
        this.activeGroupId = input.globalValues.roomId.trim();
    }

    recordEvent(event: RtcRealtimeFacadeSession.Event): void {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(
            createDirectRallarRuntimeEvent({
                topic: event.topic,
                context: this.toOperationContext(),
                transport: this.input.transport,
                severity: event.severity,
                payload: event.payload
            }),
            event.lastAction
        );
    }

    async runJoined<T>(phase: string, action: (facade: RallarFacade) => Promise<T>): Promise<T> {
        const { providerMode, authSession, timeoutMs } = this.input;
        if (providerMode !== 'browser-rallar') {
            throw new Error('RTC/Realtimes requires provider=browser-rallar.');
        }
        if (!authSession) {
            throw new Error('RTC/Realtimes requires a logged-in browser session.');
        }
        const facade = await this.runTimedPhase('load-facade', () => loadBrowserRallarFacade(), {});
        await this.runTimedPhase('configure', () => configureDirectRallarFacade(facade, this.toOperationContext()), {});
        await this.runTimedPhase(
            'start',
            () => facade.start({ connect: true, refreshRooms: false, refreshPeople: false, timeoutMs }),
            {}
        );
        await this.joinActiveGroup(facade, authSession.sessionId);
        return await this.runTimedPhase(phase, () => action(facade), {});
    }

    private async joinActiveGroup(facade: RallarFacade, sessionId: string): Promise<void> {
        const groupId = this.activeGroupId;
        if (!groupId) {
            return;
        }
        if (sessionId && isSessionActiveInGroup(facade.rooms.current(), groupId, sessionId)) {
            this.recordPhase('join', 'info', {
                status: 'skipped',
                groupId,
                reason: 'current browser session is already active in the group'
            });
            return;
        }
        const { globalValues: { applicationId, workspaceId }, timeoutMs } = this.input;
        await this.runTimedPhase(
            'join',
            () => facade.rooms.join(groupId, { scope: { applicationId, workspaceId }, timeoutMs }),
            { groupId }
        );
    }

    private async runTimedPhase<T>(
        phase: string,
        action: () => Promise<T> | T,
        details: RtcRealtimeFacadeSession.PhaseDetails
    ): Promise<T> {
        const startedAtMs = readMonotonicNowMs();
        try {
            const value = await action();
            this.recordPhase(phase, 'info', { ...details, status: 'ok', durationMs: readPhaseDurationMs(startedAtMs) });
            return value;
        }
        catch (error) {
            this.recordPhase(phase, 'error', {
                ...details,
                status: 'error',
                durationMs: readPhaseDurationMs(startedAtMs),
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }

    private recordPhase(
        phase: string,
        severity: RallarBlackBoxTestSeverity,
        details: RtcRealtimeFacadeSession.PhaseDetails
    ): void {
        this.recordEvent({
            topic: 'rallar.direct.rtc_realtime.phase',
            severity,
            payload: { phase, ...details },
            lastAction: undefined
        });
    }

    private toOperationContext(): DirectRallarOperationContext {
        const { providerMode, globalValues, actor, authSession, timeoutMs } = this.input;
        return {
            providerMode,
            apiBaseUrl: globalValues.apiBaseUrl,
            applicationId: globalValues.applicationId,
            workspaceId: globalValues.workspaceId,
            roomId: this.activeGroupId,
            actor,
            connection: 'rtc-realtime',
            authSession,
            timeoutMs
        };
    }
}

function isSessionActiveInGroup(
    room: ReturnType<RallarFacade['rooms']['current']>,
    groupId: string,
    sessionId: string
): boolean {
    const snapshot = recordValue(room);
    const group = recordValue(snapshot.group);
    return stringValue(group.groupId ?? snapshot.groupId) === groupId &&
        recordArray(snapshot.activeSessions).some((session) => stringValue(session.sessionId) === sessionId);
}

function readMonotonicNowMs(): number {
    return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function readPhaseDurationMs(startedAtMs: number): number {
    return Math.round((readMonotonicNowMs() - startedAtMs) * 100) / 100;
}
