import { WS_QUEUE_BOX_SERVER_MAX_RECEIPT_AGGREGATES } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts';

/** The round trips to the database a run adds its shape's latency to. */
export const ROOM_SEND_DELAYED_ROUND_TRIPS: readonly string[] = [
    'Every statement the three instances send outside a transaction waits the delay before it is sent.',
    'A transaction waits the delay after BEGIN, before each of its statements and before COMMIT or ROLLBACK, and ' +
    'holds its connection and its locks through all of it.',
    'A savepoint waits the delay before it opens, and again after it when it is rolled back.',
    'Every NOTIFY publish waits the delay before it is sent: a copy\'s live notice, the announcement of a receipt ' +
    'row and a relayed ACK.'
];

/** What reaches or leaves the database in a run with no latency added to it. */
export const ROOM_SEND_UNDELAYED_ROUND_TRIPS: readonly string[] = [
    'The delivery of a NOTIFY to its listeners.',
    'LISTEN and UNLISTEN.',
    'The opening of a connection, and the statement each pool is probed with.',
    'A second protocol round trip inside one statement: a describe before an execute, the first use of a prepared ' +
    'statement.',
    'The `set local` pair around a custom-planned statement.',
    'The warm-up of the application pools before the send window.',
    'The wait for a free connection of a pool, which is the pool\'s own time and no round trip.'
];

/** What a run of the cell does not show, or shows differently from a deployment. An artifact carries the list. */
export const ROOM_SEND_CELL_LIMITS: readonly string[] = [
    'One event loop runs the three instances and the load, where a deployment gives each instance a process. With ' +
    'no latency added the loop is busy most of the time, and two runs of one shape have differed several times ' +
    'over in how long a receipt took: an absolute delay at +0 ms measures the harness as much as the server.',
    'The delay is a timer in the run\'s process: it fires late on a busy loop, so the latency added to a round trip ' +
    'is at least the shape\'s and often more.',
    'The room authorizer admits a fixed audience and reads nothing. The API\'s reads the room\'s snapshot for each of ' +
    'the three decisions a send takes, and once more for each replay and each second dispatch: at least three ' +
    'round trips a send that no run pays.',
    'No AppInbox reader, heartbeat, presence or connect traffic runs beside the sends, and no diagnostics sink is ' +
    'installed: the pools and the loop have only the sends to serve.',
    'A recipient has no client runtime. Its socket takes every frame the server writes, a repeated copy and a copy ' +
    'ahead of its track alike, where a client drops the first and holds the second back; it sends no gap NACK of ' +
    'its own. A copy counted here was written to the recipient\'s socket, which is no delivery to an application.',
    'The envelope carries no room send fence, which a browser\'s room send carries and the server checks.',
    'A frame enters at the server\'s `acceptIncomingMessage`, below the socket bridge: its size check and its JSON ' +
    'parse are no part of a run, and a session is a socket object with no WebSocket.',
    'Under the sender recovery `client-stand-in` a publisher answers gap NACKs and repair requests, holds the ' +
    'first-hop wait and ends a send as the product\'s WS client does, with the product\'s own planning and limits. It ' +
    'does not model the client\'s outbound commits and engine timing or its ack-timeout schedule, and it ends a ' +
    'send on any NACK that may end one, where the client ends the message only for a relay\'s refusal or an open ' +
    'receipt removed. Under `none` a publisher offers each send once and answers nothing.',
    'What a browser does after `resync-required` or `receipt-exhausted` is not modelled: under either recovery a ' +
    'publisher goes on offering the next send of the same track.',
    `The receipt aggregates of an instance are bounded at ${WS_QUEUE_BOX_SERVER_MAX_RECEIPT_AGGREGATES}; the ` +
    'shapes run here stay far below it.',
    'The database is local, on the disk and the processor of the machine that runs the cell: its own time and its ' +
    'fsync are that machine\'s, and other work on the machine shows in the load average the artifact records.',
    'The artifact holds the report and the count of every observation list. It holds in full the later offers, the ' +
    'receipts, the controls and the sends the stand-in ended; of the repairs the stand-in declined, the count by ' +
    'reason, the first 200 and one row for each send and reason; and of the first offers, the ACKs, the arrivals ' +
    'and the hand-offs, only the offers that threw.'
];
