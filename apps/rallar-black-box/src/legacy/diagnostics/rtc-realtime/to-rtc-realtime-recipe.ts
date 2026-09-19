import type {
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRtcConnectCommand
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import type { CommandCenterGlobalValues } from '../../shell/global-context-model.ts';
import type { RtcRealtimeFormValues } from './rtc-realtime-contracts.ts';
import type { RtcRealtimeSendInputs } from './to-rtc-realtime-send-inputs.ts';

export interface RtcRealtimeRecipeInput {
    readonly form: RtcRealtimeFormValues;
    readonly globalValues: CommandCenterGlobalValues;
    readonly sendInputs: RtcRealtimeSendInputs;
}

export function toRtcRealtimeRecipe(
    { form, globalValues, sendInputs }: RtcRealtimeRecipeInput
): RallarBlackBoxTestRecipe {
    const { transport, timeoutMs } = form;
    return {
        schemaVersion: 1,
        recipeId: 'rallar-direct-rtc-realtime-export',
        name: 'Direct RTC/Realtimes export from Rallar Black Box',
        metadata: {
            requirements: [
                'provider=browser-rallar',
                'logged-in browser session',
                'joined group with RTC signaling available'
            ]
        },
        commands: [
            toRtcRealtimeConnectCommand(form, globalValues),
            {
                kind: 'rtc.send',
                commandId: 'rtc-realtime-send',
                transport,
                timeoutMs,
                send: transport === 'realtime' ? sendInputs.realtime : sendInputs.messagesRtc
            }
        ]
    };
}

function toRtcRealtimeConnectCommand(
    { transport, timeoutMs }: RtcRealtimeFormValues,
    { applicationId, workspaceId, roomId }: CommandCenterGlobalValues
): RallarBlackBoxTestRtcConnectCommand {
    const groupId = roomId.trim();
    if (!groupId) {
        return {
            kind: 'rtc.connect',
            commandId: 'rtc-realtime-connect',
            transport,
            timeoutMs,
            rallar: { applicationId, workspaceId }
        };
    }
    return {
        kind: 'rtc.connect',
        commandId: 'rtc-realtime-connect',
        roomId: groupId,
        transport,
        timeoutMs,
        rallar: { applicationId, workspaceId, roomRef: { applicationId, workspaceId, groupId } }
    };
}
