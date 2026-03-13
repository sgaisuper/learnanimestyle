import type * as THREE from "three";
import type { VRM, VRMExpressionPresetName, VRMHumanBoneName } from "@pixiv/three-vrm";
import type {
  SpeechAlignment,
  EmotionState,
  GazeHint,
  GestureHint,
  GestureName,
  HeadNodHint,
  SpeakingState,
  SpeechPerformance,
  VisemeCue,
  VisemeWeights,
} from "@/lib/types";

export type GazeTarget = {
  x: number;
  y: number;
};

export type AvatarSignals = {
  alignment: SpeechAlignment | null;
  performance: SpeechPerformance | null;
  playbackTimeMs: number;
  speechEnergy: number;
  gazeTarget: GazeTarget;
  elapsedTime: number;
};

export type AvatarFramingConfig = {
  cameraDistance: number;
  cameraHeight: number;
  lookAtY: number;
  modelScale: number;
  modelOffsetY: number;
  stageOffsetY: number;
};

export type MotionController = {
  framing: AvatarFramingConfig;
  update: (dt: number, signals: AvatarSignals) => void;
  dispose: () => void;
};

type RuntimeModules = {
  THREE: typeof import("three");
  VRMExpressionPresetName: typeof VRMExpressionPresetName;
  VRMHumanBoneName: typeof VRMHumanBoneName;
};

type BoneRig = {
  root: THREE.Object3D;
  hips: THREE.Object3D | null;
  spine: THREE.Object3D | null;
  chest: THREE.Object3D | null;
  upperChest: THREE.Object3D | null;
  neck: THREE.Object3D | null;
  head: THREE.Object3D | null;
  leftShoulder: THREE.Object3D | null;
  rightShoulder: THREE.Object3D | null;
  leftUpperArm: THREE.Object3D | null;
  rightUpperArm: THREE.Object3D | null;
  leftLowerArm: THREE.Object3D | null;
  rightLowerArm: THREE.Object3D | null;
  leftHand: THREE.Object3D | null;
  rightHand: THREE.Object3D | null;
};

type PoseRotations = Partial<Record<Exclude<keyof BoneRig, "root">, THREE.Euler>>;

type DriftChannel = {
  current: number;
  target: number;
  timer: number;
  min: number;
  max: number;
  durationMin: number;
  durationMax: number;
};

type BlinkState = {
  nextBlinkAt: number;
  blinkingUntil: number;
  doubleBlinkPendingAt: number | null;
};

type GestureArmOffset = { x?: number; y?: number; z?: number };

type GesturePose = Partial<Record<
  "leftUpperArm" | "rightUpperArm" | "leftLowerArm" | "rightLowerArm" | "leftHand" | "rightHand",
  GestureArmOffset
>>;

const GESTURE_POSES: Record<GestureName, GesturePose> = {
  neutral: {},
  open: {
    leftUpperArm:  { x: 0.22, z: -0.04 },
    rightUpperArm: { x: 0.22, z:  0.04 },
    leftLowerArm:  { x: 0.08 },
    rightLowerArm: { x: 0.08 },
  },
  emphasize: {
    rightUpperArm: { x: 0.28, z: 0.06 },
    rightLowerArm: { x: 0.18 },
    rightHand:     { x: 0.06 },
  },
  think: {
    leftUpperArm:  { x: 0.16, z: -0.22 },
    leftLowerArm:  { x: 0.38 },
    leftHand:      { x: -0.1 },
  },
  present: {
    rightUpperArm: { x: 0.16, y: -0.05 },
    rightLowerArm: { x: 0.1 },
    leftUpperArm:  { x: 0.06 },
  },
};

type GestureState = {
  current: GestureName;
  pending: GestureName | null;
  blend: number;
};

type MotionState = {
  blink: BlinkState;
  driftX: DriftChannel;
  driftY: DriftChannel;
  saccadeY: DriftChannel;
  headTurnDrift: DriftChannel;
  speechEnergy: number;
  mouthOpen: number;
  tailVisemeHoldMs: number;
  visemes: VisemeWeights;
  speakingState: SpeakingState;
  emotionState: EmotionState;
  headYaw: number;
  headPitch: number;
  neckYaw: number;
  neckPitch: number;
  chestTilt: number;
  breathPhase: number;
  idlePhase: number;
  gesture: GestureState;
};

type PerformanceSample = {
  visemes: VisemeWeights;
  jawOpen: number;
  emphasis: number;
  speakingState: SpeakingState;
  emotionState: EmotionState;
  blinkWeight: number;
  blinkSuppressed: boolean;
  gazeHint: GazeHint | null;
  headNod: HeadNodHint | null;
  gestureHint: GestureHint | null;
  hasActiveViseme: boolean;
  hasAlignedSpeech: boolean;
};

const ZERO_VISEMES: VisemeWeights = {
  aa: 0,
  ih: 0,
  ou: 0,
  ee: 0,
  oh: 0,
};

const DEFAULT_FRAMING: AvatarFramingConfig = {
  cameraDistance: 0.72,
  cameraHeight: 0.08,
  lookAtY: 0.6,
  modelScale: 0.68,
  modelOffsetY: 0.01,
  stageOffsetY: 0.04,
};

const MODEL_FRAMING: Record<string, AvatarFramingConfig> = {
  "avatarsample_a.vrm": {
    cameraDistance: 0.68,
    cameraHeight: 0.07,
    lookAtY: 0.62,
    modelScale: 0.72,
    modelOffsetY: 0,
    stageOffsetY: 0.02,
  },
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function damp(current: number, target: number, lambda: number, dt: number) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function degToRad(THREE_NS: typeof import("three"), value: number) {
  return THREE_NS.MathUtils.degToRad(value);
}

function randomInRange(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function createDriftChannel(
  min: number,
  max: number,
  durationMin: number,
  durationMax: number,
): DriftChannel {
  return {
    current: 0,
    target: randomInRange(min, max),
    timer: randomInRange(durationMin, durationMax),
    min,
    max,
    durationMin,
    durationMax,
  };
}

function updateDrift(channel: DriftChannel, dt: number, smoothing = 1.2) {
  channel.timer -= dt;
  if (channel.timer <= 0) {
    channel.target = randomInRange(channel.min, channel.max);
    channel.timer = randomInRange(channel.durationMin, channel.durationMax);
  }
  channel.current = damp(channel.current, channel.target, smoothing, dt);
}

function createBlinkState(elapsedTime: number): BlinkState {
  return {
    nextBlinkAt: elapsedTime + randomInRange(2.4, 4.8),
    blinkingUntil: -1,
    doubleBlinkPendingAt: null,
  };
}

function getFramingConfig(modelName: string | null) {
  if (!modelName) {
    return DEFAULT_FRAMING;
  }

  return MODEL_FRAMING[modelName.toLowerCase()] ?? DEFAULT_FRAMING;
}

function buildRig(runtime: RuntimeModules, vrm: VRM): BoneRig {
  const humanoid = vrm.humanoid;
  const { VRMHumanBoneName: Bones } = runtime;

  return {
    root: vrm.scene,
    hips: humanoid?.getNormalizedBoneNode(Bones.Hips) ?? null,
    spine: humanoid?.getNormalizedBoneNode(Bones.Spine) ?? null,
    chest: humanoid?.getNormalizedBoneNode(Bones.Chest) ?? null,
    upperChest: humanoid?.getNormalizedBoneNode(Bones.UpperChest) ?? null,
    neck: humanoid?.getNormalizedBoneNode(Bones.Neck) ?? null,
    head: humanoid?.getNormalizedBoneNode(Bones.Head) ?? null,
    leftShoulder: humanoid?.getNormalizedBoneNode(Bones.LeftShoulder) ?? null,
    rightShoulder: humanoid?.getNormalizedBoneNode(Bones.RightShoulder) ?? null,
    leftUpperArm: humanoid?.getNormalizedBoneNode(Bones.LeftUpperArm) ?? null,
    rightUpperArm: humanoid?.getNormalizedBoneNode(Bones.RightUpperArm) ?? null,
    leftLowerArm: humanoid?.getNormalizedBoneNode(Bones.LeftLowerArm) ?? null,
    rightLowerArm: humanoid?.getNormalizedBoneNode(Bones.RightLowerArm) ?? null,
    leftHand: humanoid?.getNormalizedBoneNode(Bones.LeftHand) ?? null,
    rightHand: humanoid?.getNormalizedBoneNode(Bones.RightHand) ?? null,
  };
}

function createBasePose(runtime: RuntimeModules): PoseRotations {
  const { THREE: THREE_NS } = runtime;

  return {
    hips: new THREE_NS.Euler(degToRad(THREE_NS, -1.5), 0, 0),
    spine: new THREE_NS.Euler(degToRad(THREE_NS, -1.8), 0, 0),
    chest: new THREE_NS.Euler(degToRad(THREE_NS, -1.2), 0, 0),
    upperChest: new THREE_NS.Euler(degToRad(THREE_NS, 0.6), 0, 0),
    neck: new THREE_NS.Euler(0, 0, 0),
    head: new THREE_NS.Euler(0, 0, 0),
    leftShoulder: new THREE_NS.Euler(0, 0, degToRad(THREE_NS, 5)),
    rightShoulder: new THREE_NS.Euler(0, 0, degToRad(THREE_NS, -5)),
    leftUpperArm: new THREE_NS.Euler(
      degToRad(THREE_NS, 4),
      degToRad(THREE_NS, -2),
      degToRad(THREE_NS, 18),
    ),
    rightUpperArm: new THREE_NS.Euler(
      degToRad(THREE_NS, 4),
      degToRad(THREE_NS, 2),
      degToRad(THREE_NS, -18),
    ),
    leftLowerArm: new THREE_NS.Euler(degToRad(THREE_NS, -2), 0, degToRad(THREE_NS, 4)),
    rightLowerArm: new THREE_NS.Euler(degToRad(THREE_NS, -2), 0, degToRad(THREE_NS, -4)),
    leftHand: new THREE_NS.Euler(0, 0, degToRad(THREE_NS, 1)),
    rightHand: new THREE_NS.Euler(0, 0, degToRad(THREE_NS, -1)),
  };
}

function setPoseRotation(
  bone: THREE.Object3D | null,
  base: THREE.Euler | undefined,
  offset: Partial<Record<"x" | "y" | "z", number>>,
) {
  if (!bone || !base) {
    return;
  }

  bone.rotation.set(
    base.x + (offset.x ?? 0),
    base.y + (offset.y ?? 0),
    base.z + (offset.z ?? 0),
  );
}

function getBoneWorldY(
  bone: THREE.Object3D | null,
  target: THREE.Vector3,
  fallback: number,
) {
  if (!bone) {
    return fallback;
  }

  bone.getWorldPosition(target);
  return target.y;
}

function applyNeutralPose(rig: BoneRig, basePose: PoseRotations) {
  setPoseRotation(rig.hips, basePose.hips, {});
  setPoseRotation(rig.spine, basePose.spine, {});
  setPoseRotation(rig.chest, basePose.chest, {});
  setPoseRotation(rig.upperChest, basePose.upperChest, {});
  setPoseRotation(rig.neck, basePose.neck, {});
  setPoseRotation(rig.head, basePose.head, {});
  setPoseRotation(rig.leftShoulder, basePose.leftShoulder, {});
  setPoseRotation(rig.rightShoulder, basePose.rightShoulder, {});
  setPoseRotation(rig.leftUpperArm, basePose.leftUpperArm, {});
  setPoseRotation(rig.rightUpperArm, basePose.rightUpperArm, {});
  setPoseRotation(rig.leftLowerArm, basePose.leftLowerArm, {});
  setPoseRotation(rig.rightLowerArm, basePose.rightLowerArm, {});
  setPoseRotation(rig.leftHand, basePose.leftHand, {});
  setPoseRotation(rig.rightHand, basePose.rightHand, {});
}

function getVisemeCue(performance: SpeechPerformance, playbackTimeMs: number): VisemeCue | null {
  return (
    performance.visemes.find(
      (cue) => playbackTimeMs >= cue.timeMs && playbackTimeMs <= cue.timeMs + cue.durationMs,
    ) ?? null
  );
}

function getHeadNodHint(performance: SpeechPerformance, playbackTimeMs: number): HeadNodHint | null {
  return (
    performance.headNodHints.find(
      (hint) => playbackTimeMs >= hint.startMs && playbackTimeMs <= hint.endMs,
    ) ?? null
  );
}

function getGazeHint(performance: SpeechPerformance, playbackTimeMs: number): GazeHint | null {
  return (
    performance.gazeHints.find(
      (hint) => playbackTimeMs >= hint.startMs && playbackTimeMs <= hint.endMs,
    ) ?? null
  );
}

function getGestureHint(performance: SpeechPerformance, playbackTimeMs: number): GestureHint | null {
  return (
    performance.gestureHints.find(
      (hint) => playbackTimeMs >= hint.startMs && playbackTimeMs <= hint.endMs,
    ) ?? null
  );
}

function getBlinkHintWeight(performance: SpeechPerformance, playbackTimeMs: number) {
  const hint = performance.blinkHints.find(
    (entry) => playbackTimeMs >= entry.startMs && playbackTimeMs <= entry.endMs,
  );

  if (!hint) {
    return { blinkWeight: 0, blinkSuppressed: false };
  }

  return {
    blinkWeight: hint.suppress ? 0 : hint.strength,
    blinkSuppressed: hint.suppress,
  };
}

function getSpeakingState(sampledCue: VisemeCue | null, speechEnergy: number): SpeakingState {
  if (sampledCue) {
    return sampledCue.emphasis > 0.72 ? "speaking_active" : "speaking_soft";
  }

  if (speechEnergy > 0.05) {
    return "listening";
  }

  return "silent";
}

function hasAlignedSpeech(alignment: SpeechAlignment | null, playbackTimeMs: number) {
  if (!alignment?.words.length) {
    return false;
  }

  const leadInMs = 30;
  const trailMs = 45;

  return alignment.words.some(
    (word) =>
      playbackTimeMs >= word.startMs - leadInMs &&
      playbackTimeMs <= word.endMs + trailMs,
  );
}

function samplePerformance(
  alignment: SpeechAlignment | null,
  performance: SpeechPerformance | null,
  playbackTimeMs: number,
  speechEnergy: number,
): PerformanceSample {
  const alignedSpeechActive = hasAlignedSpeech(alignment, playbackTimeMs);

  if (!performance) {
    return {
      visemes: ZERO_VISEMES,
      jawOpen: 0,
      emphasis: 0,
      speakingState: alignedSpeechActive
        ? speechEnergy > 0.16
          ? "speaking_soft"
          : "listening"
        : "silent",
      emotionState: "neutral",
      blinkWeight: 0,
      blinkSuppressed: false,
      gazeHint: null,
      headNod: null,
      gestureHint: null,
      hasActiveViseme: false,
      hasAlignedSpeech: alignedSpeechActive,
    };
  }

  const cue = getVisemeCue(performance, playbackTimeMs);
  const blink = getBlinkHintWeight(performance, playbackTimeMs);
  const isVisemeActive = cue != null && alignedSpeechActive;

  return {
    visemes: isVisemeActive ? cue.weights : ZERO_VISEMES,
    jawOpen: isVisemeActive ? cue.jawOpen : 0,
    emphasis: isVisemeActive ? cue.emphasis : 0,
    speakingState: alignedSpeechActive
      ? getSpeakingState(cue, Math.max(speechEnergy, 0.18))
      : "silent",
    emotionState: performance.emotionState,
    blinkWeight: blink.blinkWeight,
    blinkSuppressed: blink.blinkSuppressed,
    gazeHint: getGazeHint(performance, playbackTimeMs),
    headNod: getHeadNodHint(performance, playbackTimeMs),
    gestureHint: getGestureHint(performance, playbackTimeMs),
    hasActiveViseme: isVisemeActive,
    hasAlignedSpeech: alignedSpeechActive,
  };
}

function computeBlinkWeight(
  state: MotionState,
  elapsedTime: number,
  blinkHintWeight: number,
  suppress: boolean,
) {
  if (blinkHintWeight > 0) {
    return blinkHintWeight;
  }

  if (suppress) {
    state.blink.nextBlinkAt = Math.max(state.blink.nextBlinkAt, elapsedTime + 0.45);
    return 0;
  }

  if (state.blink.doubleBlinkPendingAt != null && elapsedTime >= state.blink.doubleBlinkPendingAt) {
    state.blink.blinkingUntil = elapsedTime + 0.09;
    state.blink.doubleBlinkPendingAt = null;
  }

  if (state.blink.blinkingUntil > 0 && elapsedTime <= state.blink.blinkingUntil) {
    const progress = 1 - (state.blink.blinkingUntil - elapsedTime) / 0.09;
    return progress < 0.5 ? progress * 2 : (1 - progress) * 2;
  }

  if (state.blink.blinkingUntil > 0 && elapsedTime > state.blink.blinkingUntil) {
    state.blink.blinkingUntil = -1;
  }

  if (elapsedTime >= state.blink.nextBlinkAt) {
    state.blink.blinkingUntil = elapsedTime + 0.12;
    state.blink.nextBlinkAt = elapsedTime + randomInRange(2.6, 4.9);
    state.blink.doubleBlinkPendingAt =
      Math.random() < 0.16 ? elapsedTime + randomInRange(0.16, 0.26) : null;
    return 0.12;
  }

  return 0;
}

function getEmotionModifiers(emotionState: EmotionState) {
  switch (emotionState) {
    case "curious":
      return { eyeWide: 0.1, headTilt: 0.04, gazeWeight: 1.08, chestLift: 0.02 };
    case "excited":
      return { eyeWide: 0.16, headTilt: 0.02, gazeWeight: 1.12, chestLift: 0.04 };
    case "thoughtful":
      return { eyeWide: -0.03, headTilt: -0.025, gazeWeight: 0.92, chestLift: 0.01 };
    case "reassuring":
      return { eyeWide: 0.04, headTilt: -0.015, gazeWeight: 0.96, chestLift: 0.015 };
    default:
      return { eyeWide: 0, headTilt: 0, gazeWeight: 1, chestLift: 0.015 };
  }
}

export function createMotionController(
  vrm: VRM,
  runtime: RuntimeModules,
  modelName: string | null,
): MotionController {
  const { THREE: THREE_NS } = runtime;
  const rig = buildRig(runtime, vrm);
  const basePose = createBasePose(runtime);
  const framingPreset = getFramingConfig(modelName);
  const state: MotionState = {
    blink: createBlinkState(0),
    driftX: createDriftChannel(-0.015, 0.015, 3.8, 6.2),
    driftY: createDriftChannel(-0.02, 0.025, 3.2, 5.2),
    saccadeY: createDriftChannel(-0.012, 0.012, 1.2, 2.2),
    headTurnDrift: createDriftChannel(-0.1, 0.1, 3.5, 6.5),
    speechEnergy: 0,
    mouthOpen: 0,
    tailVisemeHoldMs: 0,
    visemes: { ...ZERO_VISEMES },
    speakingState: "silent",
    emotionState: "neutral",
    headYaw: 0,
    headPitch: 0,
    neckYaw: 0,
    neckPitch: 0,
    chestTilt: 0,
    breathPhase: Math.random() * Math.PI * 2,
    idlePhase: Math.random() * Math.PI * 2,
    gesture: { current: "neutral", pending: null, blend: 0 },
  };

  vrm.scene.scale.setScalar(framingPreset.modelScale);

  vrm.humanoid?.resetNormalizedPose();
  applyNeutralPose(rig, basePose);
  vrm.humanoid?.update();

  vrm.scene.updateMatrixWorld(true);
  const initialBounds = new THREE_NS.Box3().setFromObject(vrm.scene);
  const size = new THREE_NS.Vector3();
  const center = new THREE_NS.Vector3();
  initialBounds.getSize(size);
  initialBounds.getCenter(center);
  const groundOffsetY = -initialBounds.min.y + framingPreset.modelOffsetY;
  const stageBaseY = groundOffsetY + size.y * framingPreset.stageOffsetY;
  const stageBaseX = -center.x;
  const stageBaseZ = -center.z;

  vrm.scene.position.set(stageBaseX, stageBaseY, stageBaseZ);
  vrm.scene.updateMatrixWorld(true);

  const portraitAnchor = new THREE_NS.Vector3();
  const headY = getBoneWorldY(
    rig.head,
    portraitAnchor,
    stageBaseY + size.y * 0.82,
  );
  const chestY = getBoneWorldY(
    rig.upperChest ?? rig.chest ?? rig.neck,
    portraitAnchor,
    stageBaseY + size.y * 0.58,
  );

  const framing: AvatarFramingConfig = {
    cameraDistance: Math.max(size.y * framingPreset.cameraDistance, 1.6),
    cameraHeight: headY + size.y * framingPreset.cameraHeight,
    lookAtY: chestY + (headY - chestY) * framingPreset.lookAtY,
    modelScale: framingPreset.modelScale,
    modelOffsetY: framingPreset.modelOffsetY,
    stageOffsetY: framingPreset.stageOffsetY,
  };

  return {
    framing,
    update(dt, signals) {
      const { VRMExpressionPresetName: Presets } = runtime;

      vrm.humanoid?.resetNormalizedPose();
      applyNeutralPose(rig, basePose);

      updateDrift(state.driftX, dt, 1.15);
      updateDrift(state.driftY, dt, 1.15);
      updateDrift(state.saccadeY, dt, 1.8);
      updateDrift(state.headTurnDrift, dt, 0.85);

      const performanceSample = samplePerformance(
        signals.alignment,
        signals.performance,
        signals.playbackTimeMs,
        signals.speechEnergy,
      );
      const emotion = getEmotionModifiers(performanceSample.emotionState);
      const sampledEnergy = Math.max(signals.speechEnergy, performanceSample.emphasis * 0.82);
      state.speechEnergy = damp(
        state.speechEnergy,
        sampledEnergy,
        sampledEnergy > state.speechEnergy ? 9.5 : 4.2,
        dt,
      );
      if (performanceSample.hasActiveViseme) {
        state.tailVisemeHoldMs = 90;
      } else if (!performanceSample.hasAlignedSpeech) {
        state.tailVisemeHoldMs = 0;
      } else if (state.tailVisemeHoldMs > 0) {
        state.tailVisemeHoldMs = Math.max(0, state.tailVisemeHoldMs - dt * 1000);
      }

      const shouldUseSpeechTail =
        performanceSample.hasAlignedSpeech &&
        !performanceSample.hasActiveViseme &&
        (state.tailVisemeHoldMs > 0 || state.speechEnergy > 0.08);
      const tailDecay =
        state.tailVisemeHoldMs > 0 ? 1 : clamp((state.speechEnergy - 0.04) / 0.22, 0, 1);
      const tailJawOpen = shouldUseSpeechTail
        ? clamp(0.14 + state.speechEnergy * 0.28, 0.12, 0.34) * Math.max(tailDecay, 0.38)
        : 0;
      const targetJawOpen = performanceSample.hasActiveViseme
        ? clamp(performanceSample.jawOpen + state.speechEnergy * 0.14, 0, 0.88)
        : tailJawOpen;
      const silentJawOpen = performanceSample.hasAlignedSpeech ? targetJawOpen : 0;

      state.mouthOpen = damp(
        state.mouthOpen,
        silentJawOpen,
        performanceSample.hasAlignedSpeech
          ? performanceSample.speakingState.startsWith("speaking") || shouldUseSpeechTail
            ? 14
            : 8
          : 20,
        dt,
      );
      state.visemes.aa = damp(
        state.visemes.aa,
        performanceSample.hasActiveViseme
          ? performanceSample.visemes.aa
          : state.visemes.aa * Math.max(tailDecay, 0.7),
        14,
        dt,
      );
      state.visemes.ih = damp(
        state.visemes.ih,
        performanceSample.hasActiveViseme
          ? performanceSample.visemes.ih
          : state.visemes.ih * Math.max(tailDecay, 0.7),
        14,
        dt,
      );
      state.visemes.ou = damp(
        state.visemes.ou,
        performanceSample.hasActiveViseme
          ? performanceSample.visemes.ou
          : state.visemes.ou * Math.max(tailDecay, 0.68),
        14,
        dt,
      );
      state.visemes.ee = damp(
        state.visemes.ee,
        performanceSample.hasActiveViseme
          ? performanceSample.visemes.ee
          : state.visemes.ee * Math.max(tailDecay, 0.68),
        14,
        dt,
      );
      state.visemes.oh = damp(
        state.visemes.oh,
        performanceSample.hasActiveViseme
          ? performanceSample.visemes.oh
          : state.visemes.oh * Math.max(tailDecay, 0.7),
        14,
        dt,
      );
      state.speakingState = performanceSample.speakingState;
      state.emotionState = performanceSample.emotionState;

      const targetGesture = performanceSample.gestureHint?.gesture ?? "neutral";
      const targetGestureStrength = performanceSample.gestureHint?.strength ?? 0;
      if (state.gesture.pending !== null) {
        state.gesture.blend = damp(state.gesture.blend, 0, 4.5, dt);
        if (state.gesture.blend < 0.06) {
          state.gesture.current = state.gesture.pending;
          state.gesture.pending = null;
        }
      } else if (state.gesture.current !== targetGesture) {
        state.gesture.pending = targetGesture;
        state.gesture.blend = damp(state.gesture.blend, 0, 4.5, dt);
      } else {
        state.gesture.blend = damp(state.gesture.blend, targetGestureStrength, 3.2, dt);
      }
      const idleTime = signals.elapsedTime + state.idlePhase;
      const breath = Math.sin(idleTime * 0.96 + state.breathPhase) * 0.5 + 0.5;
      const torsoSway = Math.sin(idleTime * 0.34) * 0.008 + state.driftX.current * 0.012;
      const torsoLift = Math.sin(idleTime * 0.96 + state.breathPhase) * 0.0025;
      const nodPhase = Math.sin(signals.elapsedTime * (performanceSample.speakingState === "speaking_active" ? 8.6 : 6.4));
      const nodAmount = (performanceSample.headNod?.amount ?? 0) * state.speechEnergy * 0.72;
      const gazeHintY = (performanceSample.gazeHint?.y ?? 0) * (performanceSample.gazeHint?.weight ?? 0);
      const microSaccadeY =
        performanceSample.speakingState === "silent" || performanceSample.speakingState === "listening"
          ? state.saccadeY.current * 0.16
          : state.saccadeY.current * 0.03;
      const gazeBaseX = state.driftX.current * 0.01;
      const gazeBaseY = signals.gazeTarget.y * 0.06 + state.driftY.current * 0.05 + microSaccadeY;
      const gazeX = clamp(gazeBaseX * emotion.gazeWeight, -0.015, 0.015);
      const gazeY = clamp(gazeBaseY + gazeHintY, -0.05, 0.05);
      const talkingLock = performanceSample.speakingState === "speaking_active" ? 0.78 : performanceSample.speakingState === "speaking_soft" ? 0.9 : 1;
      const speakingTurnScale =
        performanceSample.speakingState === "speaking_active" ? 1.0
        : performanceSample.speakingState === "speaking_soft" ? 0.82
        : performanceSample.speakingState === "listening" ? 0.28
        : 0.12;
      const emotionTurnScale =
        performanceSample.emotionState === "excited" ? 1.18
        : performanceSample.emotionState === "curious" ? 1.05
        : performanceSample.emotionState === "thoughtful" ? 0.65
        : performanceSample.emotionState === "reassuring" ? 0.88
        : 0.95;
      const headTurnContrib = state.headTurnDrift.current * speakingTurnScale * emotionTurnScale;
      const targetHeadYaw = gazeX * 0.015 * talkingLock + headTurnContrib;
      const targetHeadPitch = gazeY * 0.12 * talkingLock + nodPhase * nodAmount * 0.08 + emotion.headTilt;
      const targetNeckYaw = gazeX * 0.008 * talkingLock + headTurnContrib * 0.5;
      const targetNeckPitch = gazeY * 0.05 * talkingLock + nodPhase * nodAmount * 0.04;

      state.headYaw = damp(state.headYaw, targetHeadYaw, 5.2, dt);
      state.headPitch = damp(state.headPitch, targetHeadPitch, 5.2, dt);
      state.neckYaw = damp(state.neckYaw, targetNeckYaw, 4.4, dt);
      state.neckPitch = damp(state.neckPitch, targetNeckPitch, 4.4, dt);
      state.chestTilt = damp(
        state.chestTilt,
        torsoSway + nodPhase * nodAmount * 0.05 + emotion.chestLift,
        4.1,
        dt,
      );

      rig.root.position.y = damp(rig.root.position.y, stageBaseY + torsoLift, 3.2, dt);
      rig.root.position.x = damp(rig.root.position.x, stageBaseX + torsoSway * 0.08, 3.2, dt);
      rig.root.position.z = stageBaseZ;

      setPoseRotation(rig.hips, basePose.hips, {
        z: torsoSway * 0.08,
      });
      setPoseRotation(rig.spine, basePose.spine, {
        x: THREE_NS.MathUtils.degToRad(-0.1 + breath * 0.5),
        z: state.chestTilt * 0.2,
      });
      setPoseRotation(rig.chest, basePose.chest, {
        x: THREE_NS.MathUtils.degToRad(breath * 0.6) + nodPhase * nodAmount * 0.018,
        z: state.chestTilt * 0.38,
      });
      setPoseRotation(rig.upperChest, basePose.upperChest, {
        x: THREE_NS.MathUtils.degToRad(0.18 + breath * 0.48) + nodPhase * nodAmount * 0.014,
        z: state.chestTilt * 0.28,
      });
      setPoseRotation(rig.neck, basePose.neck, {
        x: state.neckPitch,
        y: state.neckYaw,
        z: -torsoSway * 0.6,
      });
      setPoseRotation(rig.head, basePose.head, {
        x: state.headPitch,
        y: state.headYaw,
        z: -torsoSway * 0.42,
      });

      const shoulderLift = THREE_NS.MathUtils.degToRad(breath * 0.35) + nodAmount * 0.01;
      const leftArmOffset = Math.sin(idleTime * 0.52) * 0.006;
      const rightArmOffset = Math.sin(idleTime * 0.48 + 1.3) * 0.006;
      const gp = GESTURE_POSES[state.gesture.current];
      const gb = state.gesture.blend;

      setPoseRotation(rig.leftShoulder, basePose.leftShoulder, {
        z: shoulderLift + torsoSway * 0.1,
      });
      setPoseRotation(rig.rightShoulder, basePose.rightShoulder, {
        z: -shoulderLift + torsoSway * 0.1,
      });
      setPoseRotation(rig.leftUpperArm, basePose.leftUpperArm, {
        x: THREE_NS.MathUtils.degToRad(breath * 0.5) + (gp.leftUpperArm?.x ?? 0) * gb,
        y: (gp.leftUpperArm?.y ?? 0) * gb,
        z: leftArmOffset + (gp.leftUpperArm?.z ?? 0) * gb,
      });
      setPoseRotation(rig.rightUpperArm, basePose.rightUpperArm, {
        x: THREE_NS.MathUtils.degToRad(breath * 0.5) + (gp.rightUpperArm?.x ?? 0) * gb,
        y: (gp.rightUpperArm?.y ?? 0) * gb,
        z: -rightArmOffset + (gp.rightUpperArm?.z ?? 0) * gb,
      });
      setPoseRotation(rig.leftLowerArm, basePose.leftLowerArm, {
        x: (gp.leftLowerArm?.x ?? 0) * gb,
        z: leftArmOffset * 0.45 + (gp.leftLowerArm?.z ?? 0) * gb,
      });
      setPoseRotation(rig.rightLowerArm, basePose.rightLowerArm, {
        x: (gp.rightLowerArm?.x ?? 0) * gb,
        z: -rightArmOffset * 0.45 + (gp.rightLowerArm?.z ?? 0) * gb,
      });
      setPoseRotation(rig.leftHand, basePose.leftHand, {
        x: (gp.leftHand?.x ?? 0) * gb,
        z: leftArmOffset * 0.25 + (gp.leftHand?.z ?? 0) * gb,
      });
      setPoseRotation(rig.rightHand, basePose.rightHand, {
        x: (gp.rightHand?.x ?? 0) * gb,
        z: -rightArmOffset * 0.25 + (gp.rightHand?.z ?? 0) * gb,
      });

      const blink = computeBlinkWeight(
        state,
        signals.elapsedTime,
        performanceSample.blinkWeight,
        performanceSample.blinkSuppressed,
      );

      if (vrm.lookAt) {
        vrm.lookAt.target = null;
      }

      const expressionManager = vrm.expressionManager;
      if (expressionManager) {
        expressionManager.resetValues();
        expressionManager.setValue(Presets.Aa, clamp(state.visemes.aa * 0.78 + state.mouthOpen * 0.22, 0, 1));
        expressionManager.setValue(Presets.Oh, clamp(state.visemes.oh * 0.68 + state.visemes.ou * 0.24, 0, 1));
        expressionManager.setValue(Presets.Ou, clamp(state.visemes.ou * 0.72, 0, 1));
        expressionManager.setValue(Presets.Ee, clamp(state.visemes.ee * 0.72, 0, 1));
        expressionManager.setValue(Presets.Ih, clamp(state.visemes.ih * 0.74, 0, 1));
        expressionManager.setValue(Presets.Blink, clamp(blink, 0, 1));
        expressionManager.setValue(Presets.Relaxed, clamp(0.18 + (state.emotionState === "reassuring" ? 0.16 : 0), 0, 0.34));
        expressionManager.setValue(Presets.Surprised, clamp(emotion.eyeWide + state.speechEnergy * 0.08, 0, 0.24));
        expressionManager.setValue(Presets.Happy, clamp(
          state.emotionState === "excited"
            ? 0.22 + state.speechEnergy * 0.14
            : state.emotionState === "reassuring"
              ? 0.12
              : 0,
          0,
          0.36,
        ));
      }

      vrm.humanoid?.update();
    },
    dispose() {
      if (vrm.lookAt) {
        vrm.lookAt.target = null;
      }
    },
  };
}
