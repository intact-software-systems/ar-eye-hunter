import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

/** The command the manual workbench offers as its starting example. */
export const RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE: RallarBlackBoxTestCommand = {
    kind: 'rtc.send',
    commandId: 'manual-rtc-send',
    connection: 'aliceRtc',
    transport: 'realtime',
    send: {
        data: {
            topic: 'room.manual.message',
            text: 'hello from manual command'
        }
    }
};
