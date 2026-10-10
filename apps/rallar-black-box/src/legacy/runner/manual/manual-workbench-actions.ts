import type * as React from 'react';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { Either } from '@shared/resilience/Either.ts';

import {
    type ManualActionHistoryEntry,
    type ManualWorkbenchAction,
    type ManualWorkbenchTransport,
    type ManualWorkbenchValues
} from '../../../manual-workbench.ts';
import {
    toManualRtcDeliveryMatrixCommands,
    toManualRtcNackProbeCommands
} from '../../../manual-workbench/manual-rtc-probe-commands.ts';
import { toManualWorkbenchCommands } from '../../../manual-workbench/manual-workbench-commands.ts';
import type { rallarBlackBoxRuntimeStore } from '../../../runtime-store.ts';
import { uiRedactionOptions } from '../../shared/redaction-presentation.ts';
import { writeTextToClipboard } from '../../shared/write-text-to-clipboard.ts';
import type { ManualRallarWorkbenchOptions } from './manual-rallar-workbench-options.ts';
import { toManualActionLabel } from './to-manual-action-label.ts';

export namespace ManualWorkbenchActions {
    export interface Input extends ManualRallarWorkbenchOptions {
        readonly values: ManualWorkbenchValues;
        readonly rtcReadinessResult: Either<string, RallarBlackBoxTestRtcConnectCommand>;
        readonly sequence: number;
        readonly payloadResult: Either<string, RallarMessagePayload>;
        readonly recipeText: string;
        readonly negativeRecipeText: string;
        readonly lifetime: { readonly active: boolean; };
        readonly setSequence: React.Dispatch<React.SetStateAction<number>>;
        readonly setHistory: React.Dispatch<React.SetStateAction<readonly ManualActionHistoryEntry[]>>;
        readonly setLocalError: React.Dispatch<React.SetStateAction<string | undefined>>;
        readonly runManualCommands: typeof rallarBlackBoxRuntimeStore.runManualCommands;
        nowMs(): number;
        createRequestId(): string;
    }
}
export class ManualWorkbenchActions {
    /** Each invocation captures the current draft before admission effects or awaits. */
    private readonly readCurrentInput: () => ManualWorkbenchActions.Input;
    constructor(readCurrentInput: () => ManualWorkbenchActions.Input) {
        this.readCurrentInput = readCurrentInput;
    }

    private readonly runManualCommandSet = async (
        input: ManualWorkbenchActions.Input,
        label: string,
        commands: readonly RallarBlackBoxTestCommand[]
    ): Promise<void> => {
        if (!input.lifetime.active) {
            return;
        }
        const startSequence = input.sequence;
        const entry: ManualActionHistoryEntry = {
            actionId: `manual-action-${startSequence}`,
            label,
            commandIds: commands.map(
                (command) => command.commandId ?? command.kind
            ),
            commands: redactRallarBlackBoxValue(
                commands,
                uiRedactionOptions(input.state, input.authSession, [input.values.rallarPassword])
            ),
            atEpochMs: input.nowMs()
        };

        input.setSequence((current) => current + commands.length + 1);
        input.setHistory((current) => [...current, entry].slice(-12));
        input.onSelectCommand(entry.commandIds.at(-1) ?? entry.commandIds[0]);

        try {
            await input.runManualCommands(
                commands,
                label
            );
        }
        catch (error) {
            if (!input.lifetime.active) {
                return;
            }
            input.setLocalError(
                error instanceof Error ? error.message : String(error)
            );
        }
    };

    public readonly runManualAction = async (
        action: ManualWorkbenchAction
    ): Promise<void> => {
        const input = this.readCurrentInput();
        if (!input.lifetime.active) {
            return;
        }
        input.setLocalError(undefined);
        const payloadError = input.payloadResult.foldLeft((error) => error);
        if (action === 'send' && payloadError !== undefined) {
            input.setLocalError(payloadError);
            return;
        }
        if (
            (action === 'connect' || action === 'join') && input.values.transport !== 'ws' &&
            this.admitRtcConnect(input) === undefined
        ) {
            return;
        }
        const selectedGroupId = input.values.groupId.trim();
        if (
            selectedGroupId &&
            ['configure', 'join', 'connect', 'send'].includes(action) &&
            input.globalValues.roomId !== selectedGroupId
        ) {
            input.onGlobalValueChange('roomId', selectedGroupId);
        }

        const label = toManualActionLabel(action);
        const startSequence = input.sequence;
        const commands = toManualWorkbenchCommands({
            action: action,
            rtcReadinessResult: input.rtcReadinessResult,
            values: input.values,
            payload: input.payloadResult.fold(() => null, (payload) => payload),
            sequence: startSequence,
            requestId: input.createRequestId()
        });
        await this.runManualCommandSet(input, label, commands);
    };

    public readonly runRtcMatrix = async (
        transport: Extract<ManualWorkbenchTransport, 'realtime' | 'messages.rtc'>
    ): Promise<void> => {
        const input = this.readCurrentInput();
        if (!input.lifetime.active) {
            return;
        }
        const rtcConnect = this.admitRtcConnect(input);
        if (rtcConnect === undefined) {
            return;
        }
        input.setLocalError(undefined);
        await input.payloadResult.fold(
            async (error) => input.setLocalError(error),
            async (payload) => {
                const startSequence = input.sequence;
                const commands = toManualRtcDeliveryMatrixCommands({
                    rtcConnect,
                    values: input.values,
                    payload,
                    sequence: startSequence,
                    transport,
                    requestId: input.createRequestId()
                });
                await this.runManualCommandSet(input, `RTC ${transport} delivery matrix`, commands);
            }
        );
    };

    public readonly runRtcNackProbe = async (): Promise<void> => {
        const input = this.readCurrentInput();
        if (!input.lifetime.active) {
            return;
        }
        input.setLocalError(undefined);
        await input.payloadResult.fold(
            async (error) => input.setLocalError(error),
            async (payload) => {
                const startSequence = input.sequence;
                const commands = toManualRtcNackProbeCommands(input.values, payload, startSequence);
                await this.runManualCommandSet(input, 'RTC not-yet-in-sync probe', commands);
            }
        );
    };

    public readonly copyRecipeSnippet = (): Promise<void> => {
        const input = this.readCurrentInput();
        return this.copyText(input, input.recipeText);
    };
    public readonly copyNegativeRecipe = async (): Promise<void> => {
        const input = this.readCurrentInput();
        if (!input.lifetime.active || this.admitRtcConnect(input) === undefined) {
            return;
        }
        await this.copyText(input, input.negativeRecipeText);
    };
    public readonly copyRtcMatrixRecipe = async (): Promise<void> => {
        const input = this.readCurrentInput();
        if (!input.lifetime.active) {
            return;
        }
        const rtcConnect = this.admitRtcConnect(input);
        if (rtcConnect === undefined) {
            return;
        }
        await input.payloadResult.fold(
            async (error) => input.setLocalError(error),
            (payload) => this.copyText(input, this.createRtcMatrixRecipeText(input, payload, rtcConnect))
        );
    };

    private admitRtcConnect(input: ManualWorkbenchActions.Input): RallarBlackBoxTestRtcConnectCommand | undefined {
        input.rtcReadinessResult.foldLeft(input.setLocalError);
        return input.rtcReadinessResult.right;
    }

    private createRtcMatrixRecipeText(
        input: ManualWorkbenchActions.Input,
        payload: RallarMessagePayload,
        rtcConnect: RallarBlackBoxTestRtcConnectCommand
    ): string {
        const realtime = toManualRtcDeliveryMatrixCommands({
            rtcConnect,
            values: input.values,
            payload,
            sequence: 1,
            transport: 'realtime',
            requestId: input.createRequestId()
        });
        const messages = toManualRtcDeliveryMatrixCommands({
            rtcConnect,
            values: input.values,
            payload,
            sequence: realtime.length + 2,
            transport: 'messages.rtc',
            requestId: input.createRequestId()
        });
        return JSON.stringify(
            {
                schemaVersion: 1,
                recipeId: 'manual-rtc-delivery-matrix',
                name: 'Manual RTC delivery matrix',
                description: 'Direct, multicast, and broadcast delivery over realtime and messages.rtc.',
                continueOnFailure: false,
                commands: [...realtime, ...messages]
            },
            null,
            2
        );
    }

    private async copyText(input: ManualWorkbenchActions.Input, text: string): Promise<void> {
        if (!(input.lifetime.active)) {
            return;
        }
        input.setLocalError(undefined);
        const written = await writeTextToClipboard(text);
        if (input.lifetime.active) {
            written.foldLeft(input.setLocalError);
        }
    }
}
