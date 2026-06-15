# Motion Smoothing

Rallar Motion smooths received snapshots for presentation. It does not own
simulation, collision, scoring, or authority.

```ts
import {
    createRallarMotionAdaptiveDelay,
    createRallarMotionBuffer,
    createRallarMotionSendGate,
} from '@shared/rallar-motion/mod.ts';
import { rallar } from '@shared-web/browser/rallar.ts';

type Pose = {
    entityId: string;
    seq: number;
    position: readonly [number, number, number];
    velocity?: readonly [number, number, number];
};

const delay = createRallarMotionAdaptiveDelay({
    defaultDelayMs: 100,
    minDelayMs: 60,
    maxDelayMs: 180,
});

const buffer = createRallarMotionBuffer<{ seq: number }>({
    interpolationDelayMs: 100,
    readInterpolationDelayMs: delay.currentDelayMs,
    maxExtrapolationMs: 120,
});

const poseGate = createRallarMotionSendGate({
    cadenceMs: 33,
    idleCadenceMs: 500,
    minPositionDelta: 0.02,
});

const poses = rallar.realtime.room<Pose>({
    roomRef: currentRoom.group,
    laneId: 'game-snapshot',
    waitTimeoutMs: 500,
});

poses.on((message) => {
    const pose = message.data;
    delay.pushObservedAt(message.receivedAtEpochMs);
    buffer.push({
        entityId: pose.entityId,
        observedAtEpochMs: message.receivedAtEpochMs,
        position: pose.position,
        velocity: pose.velocity,
        seq: pose.seq,
        metadata: { seq: pose.seq },
    });
});

function renderFrame(nowEpochMs: number) {
    for (const entityId of visibleRemoteEntityIds()) {
        const estimate = buffer.sample(entityId, nowEpochMs);
        if (estimate) {
            renderRemoteEntity(entityId, estimate.position, estimate.confidence);
        }
    }
}

const nowEpochMs = Date.now();
const gateDecision = poseGate.check({ position: localPose.position }, nowEpochMs);
if (gateDecision.shouldSend) {
    poseGate.recordSent({ position: localPose.position }, nowEpochMs);
    await poses.send({
        entityId: localPlayerId,
        seq: nextSnapshotSeq(),
        position: localPose.position,
        velocity: localPose.velocity,
    });
}
```

Use sender timestamps for diagnostics unless the app has explicit clock sync.
Push received samples with the local receiver clock.
