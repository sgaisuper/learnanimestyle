"use client";

import { useEffect, useRef, useState } from "react";
import {
  createMotionController,
  type AvatarSignals,
  type GazeTarget,
  type MotionController,
} from "@/components/avatar-motion-controller";
import type { SpeechAlignment, SpeechPerformance } from "@/lib/types";

type VrmAvatarProps = {
  alignment: SpeechAlignment | null;
  performance: SpeechPerformance | null;
  playbackTimeMs: number;
  speechEnergy: number;
  gazeTarget: GazeTarget;
  modelFile: File | null;
};

const defaultModelUrl = "/vrm/AvatarSample_A.vrm";

type RuntimeModules = {
  THREE: typeof import("three");
  GLTFLoader: typeof import("three/examples/jsm/loaders/GLTFLoader.js").GLTFLoader;
  VRMLoaderPlugin: typeof import("@pixiv/three-vrm").VRMLoaderPlugin;
  VRMExpressionPresetName: typeof import("@pixiv/three-vrm").VRMExpressionPresetName;
  VRMHumanBoneName: typeof import("@pixiv/three-vrm").VRMHumanBoneName;
};

type ViewerState = {
  renderer: import("three").WebGLRenderer;
  scene: import("three").Scene;
  camera: import("three").PerspectiveCamera;
  clock: import("three").Clock;
  currentVrm: import("@pixiv/three-vrm").VRM | null;
  controller: MotionController | null;
  animationFrame: number | null;
};

export function VrmAvatar({
  alignment,
  performance,
  playbackTimeMs,
  speechEnergy,
  gazeTarget,
  modelFile,
}: VrmAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<ViewerState | null>(null);
  const runtimeRef = useRef<RuntimeModules | null>(null);
  const signalsRef = useRef<AvatarSignals>({
    alignment,
    performance,
    playbackTimeMs,
    speechEnergy,
    gazeTarget,
    elapsedTime: 0,
  });
  const [runtimeReady, setRuntimeReady] = useState(false);

  useEffect(() => {
    signalsRef.current = {
      ...signalsRef.current,
      alignment,
      performance,
      playbackTimeMs,
      speechEnergy,
      gazeTarget,
    };
  }, [alignment, gazeTarget, performance, playbackTimeMs, speechEnergy]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewerRef.current) {
      return;
    }

    let cancelled = false;
    let resizeHandler: (() => void) | null = null;

    const boot = async () => {
      const [THREE, gltfModule, vrmModule] = await Promise.all([
        import("three"),
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("@pixiv/three-vrm"),
      ]);

      if (cancelled || !canvas) {
        return;
      }

      const runtime: RuntimeModules = {
        THREE,
        GLTFLoader: gltfModule.GLTFLoader,
        VRMLoaderPlugin: vrmModule.VRMLoaderPlugin,
        VRMExpressionPresetName: vrmModule.VRMExpressionPresetName,
        VRMHumanBoneName: vrmModule.VRMHumanBoneName,
      };

      runtimeRef.current = runtime;
      setRuntimeReady(true);

      const renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 50);
      const ambientLight = new THREE.AmbientLight(0xffffff, 1.6);
      const fillLight = new THREE.DirectionalLight(0xfff3ea, 2);
      const rimLight = new THREE.DirectionalLight(0xf9c9b7, 1.15);
      fillLight.position.set(0.8, 1.2, 1.6);
      rimLight.position.set(-1.2, 0.8, -0.6);
      scene.add(ambientLight);
      scene.add(fillLight);
      scene.add(rimLight);

      const clock = new THREE.Clock();
      const viewer: ViewerState = {
        renderer,
        scene,
        camera,
        clock,
        currentVrm: null,
        controller: null,
        animationFrame: null,
      };

      resizeHandler = () => {
        const width = canvas.clientWidth || 1;
        const height = canvas.clientHeight || 1;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };

      const tick = () => {
        resizeHandler?.();
        const dt = Math.min(clock.getDelta(), 1 / 24);

        if (viewer.currentVrm && viewer.controller) {
          signalsRef.current.elapsedTime += dt;
          viewer.controller.update(dt, signalsRef.current);
          viewer.currentVrm.update(dt);
        }

        renderer.render(scene, camera);
        viewer.animationFrame = window.requestAnimationFrame(tick);
      };

      viewer.animationFrame = window.requestAnimationFrame(tick);
      viewerRef.current = viewer;
      window.addEventListener("resize", resizeHandler);
      resizeHandler();
    };

    void boot();

    return () => {
      cancelled = true;

      if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
      }

      const viewer = viewerRef.current;
      if (viewer?.animationFrame != null) {
        window.cancelAnimationFrame(viewer.animationFrame);
      }

      viewer?.controller?.dispose();
      if (viewer?.currentVrm) {
        viewer.scene.remove(viewer.currentVrm.scene);
      }

      viewer?.renderer.dispose();
      viewerRef.current = null;
      runtimeRef.current = null;
      setRuntimeReady(false);
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const runtime = runtimeRef.current;
    if (!viewer || !runtime) {
      return;
    }

    let disposed = false;
    const sourceUrl = modelFile ? URL.createObjectURL(modelFile) : defaultModelUrl;
    const loader = new runtime.GLTFLoader();
    loader.register((parser) => new runtime.VRMLoaderPlugin(parser));

    loader.load(
      sourceUrl,
      (gltf) => {
        if (disposed) {
          return;
        }

        const vrm = gltf.userData.vrm as import("@pixiv/three-vrm").VRM | undefined;
        if (modelFile) {
          URL.revokeObjectURL(sourceUrl);
        }

        if (!vrm) {
          return;
        }

        viewer.controller?.dispose();
        if (viewer.currentVrm) {
          viewer.scene.remove(viewer.currentVrm.scene);
        }

        vrm.scene.rotation.y = Math.PI;
        vrm.scene.traverse((object) => {
          object.frustumCulled = false;
        });

        const modelName = modelFile?.name ?? "AvatarSample_A.vrm";
        const controller = createMotionController(vrm, runtime, modelName);
        viewer.currentVrm = vrm;
        viewer.controller = controller;
        viewer.scene.add(vrm.scene);

        viewer.camera.position.set(0, controller.framing.cameraHeight, controller.framing.cameraDistance);
        viewer.camera.lookAt(0, controller.framing.lookAtY, 0);
        viewer.camera.updateProjectionMatrix();
      },
      undefined,
      (error) => {
        if (modelFile) {
          URL.revokeObjectURL(sourceUrl);
        }
        console.error("Failed to load VRM", error);
      },
    );

    return () => {
      disposed = true;
      if (modelFile) {
        URL.revokeObjectURL(sourceUrl);
      }
    };
  }, [modelFile, runtimeReady]);

  return (
    <div className="vrm-avatar-shell">
      <canvas ref={canvasRef} className="vrm-canvas" />
    </div>
  );
}
