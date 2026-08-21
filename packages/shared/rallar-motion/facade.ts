import { createRallarMotionAdaptiveDelay } from './adaptive-delay.ts';
import { createRallarMotionBuffer } from './buffer.ts';
import { createRallarMotionCorrectionBlender } from './correction-blender.ts';
import { classifyRallarMotionDiscontinuity } from './discontinuity.ts';
import { deadReckonRallarMotion, interpolateRallarMotion, interpolateRallarMotionHermite } from './interpolation.ts';
import {
    createRallarMotionKinematicsEstimator,
    estimateRallarMotionAcceleration,
    estimateRallarMotionVelocity
} from './kinematics.ts';
import { dequantizeRallarMotionVec3, quantizeRallarMotionVec3, roundRallarMotionVec3 } from './math.ts';
import { createRallarMotionSendGate, shouldSendRallarMotionSample, shouldSendRallarMotionUpdate } from './send-gate.ts';

export const RallarMotion = {
    createBuffer: createRallarMotionBuffer,
    createAdaptiveDelay: createRallarMotionAdaptiveDelay,
    createCorrectionBlender: createRallarMotionCorrectionBlender,
    createKinematicsEstimator: createRallarMotionKinematicsEstimator,
    createSendGate: createRallarMotionSendGate,
    interpolate: interpolateRallarMotion,
    interpolateHermite: interpolateRallarMotionHermite,
    deadReckon: deadReckonRallarMotion,
    classifyDiscontinuity: classifyRallarMotionDiscontinuity,
    estimateVelocity: estimateRallarMotionVelocity,
    estimateAcceleration: estimateRallarMotionAcceleration,
    shouldSendSample: shouldSendRallarMotionSample,
    shouldSendUpdate: shouldSendRallarMotionUpdate,
    quantizeVec3: quantizeRallarMotionVec3,
    dequantizeVec3: dequantizeRallarMotionVec3,
    roundVec3: roundRallarMotionVec3
} as const;
