import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
import { startBlowDetector } from './blow.js';

const BASE_URL = import.meta.env.BASE_URL;
const TARGET_URL = `${BASE_URL}targets/school-logo.mind`;
const HAND_MODEL_URL = `${BASE_URL}mediapipe/hand_landmarker.task`;
// Keep the vision runtime on the same origin as the app. The hosted CDN is
// frequently unavailable on mobile/campus networks, which silently disables
// all hand interactions while image tracking still appears to work.
const MEDIAPIPE_WASM_URL = `${BASE_URL}mediapipe/wasm`;
const CHARACTERS = [
  {
    key: 'heart',
    model: `${BASE_URL}characters/models/ip_01_heart_static.fbx`,
    pat: `${BASE_URL}characters/animations/heart_pat.glb`,
    pull: `${BASE_URL}characters/animations/heart_pull.glb`,
  },
  {
    key: 'bubble',
    model: `${BASE_URL}characters/models/ip_02_bubble_static.fbx`,
    pat: `${BASE_URL}characters/animations/bubble_pat.glb`,
    pull: `${BASE_URL}characters/animations/bubble_pull.glb`,
  },
  {
    key: 'leaf',
    model: `${BASE_URL}characters/models/ip_03_leaf_static.fbx`,
    pat: `${BASE_URL}characters/animations/leaf_pat.glb`,
    pull: `${BASE_URL}characters/animations/leaf_pull.glb`,
  },
];
const CHARACTER_SPAN = 0.88;
const FLOAT_AMPLITUDE = 0.012;
const BREATH_AMPLITUDE = 0.025;
// Sample often enough to retain short left-right-left strokes on mobile.
const HAND_INTERVAL_MS = 66;
const ACTION_COOLDOWN_MS = 750;
const HAND_MISS_RESET_MS = 280;
const TURN_SPEED_MAX = 0.00025;
const TURN_RADIANS_PER_SCREEN_WIDTH = Math.PI * 4;
const TURN_RETURN_DELAY_MS = 1500;

async function assertAssetAvailable(url, label) {
  const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  if (!response.ok || (response.headers.get('content-type') || '').includes('text/html')) {
    throw new Error(`${label}加载失败：${url}`);
  }
}

function loadFbx(loader, url) {
  return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

function loadGltf(loader, url) {
  return loader.loadAsync(url);
}

function prepareCharacter(model, name, targetWidth) {
  model.traverse((object) => {
    if (!object.isMesh) return;
    object.castShadow = false;
    object.receiveShadow = false;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => { if (material) material.side = THREE.DoubleSide; });
  });

  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = targetWidth / Math.max(size.x, 0.0001);
  model.scale.setScalar(scale);
  model.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  model.updateMatrixWorld(true);

  const wrapper = new THREE.Group();
  wrapper.name = name;
  wrapper.add(model);
  wrapper.userData.modelHeight = size.y * scale;
  wrapper.userData.modelWidth = size.x * scale;
  return wrapper;
}

function pointInViewport(landmark, video, bounds) {
  const frameWidth = video.videoWidth;
  const frameHeight = video.videoHeight;
  if (!frameWidth || !frameHeight) return null;

  const frameAspect = frameWidth / frameHeight;
  const viewportAspect = bounds.width / bounds.height;
  let x = landmark.x;
  let y = landmark.y;
  if (frameAspect > viewportAspect) {
    const visibleWidth = viewportAspect / frameAspect;
    x = (x - (1 - visibleWidth) / 2) / visibleWidth;
  } else {
    const visibleHeight = frameAspect / viewportAspect;
    y = (y - (1 - visibleHeight) / 2) / visibleHeight;
  }
  return { x, y };
}

function projectPoint(point, camera) {
  const projected = point.clone().project(camera);
  return { x: (projected.x + 1) / 2, y: (1 - projected.y) / 2 };
}

function distance2D(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function createARSession({ container, ui }) {
  let mindar = null;
  let characters = [];
  let handLandmarker = null;
  let handLandmarkerTask = null;
  let blowDetector = null;
  let blowDetectorTask = null;
  let actionCache = new Map();
  let targetVisible = false;
  let stopped = false;
  let lastHandFrameAt = 0;
  let lastRenderAt = 0;
  let lastHandSeenAt = 0;
  let handTrail = [];
  let previousHandPoint = null;
  let patGesture = null;

  function makeCharacterRecord(baseModel, data, index, spacing, targetWidth, row) {
    const pose = new THREE.Group();
    pose.name = `character-${data.key}`;
    pose.position.set((index - 1) * spacing, 0, 0);
    pose.userData.floatPhase = index * 1.55;
    pose.userData.baseY = 0;
    pose.userData.lastActionAt = -Infinity;
    pose.userData.touchStartedAt = null;
    pose.userData.turnAngle = 0;
    pose.userData.lastTurnGestureAt = -Infinity;
    pose.userData.blowSpinVelocity = 0;

    const base = prepareCharacter(baseModel, `${data.key}-static`, targetWidth);
    pose.userData.modelHeight = base.userData.modelHeight;
    pose.add(base);
    row.add(pose);

    return { data, pose, base, variants: new Map(), activeVariant: null, busy: false };
  }

  async function getActionVariant(record, actionName) {
    const existing = record.variants.get(actionName);
    if (existing) return existing;

    const url = record.data[actionName];
    const cacheKey = `${record.data.key}:${actionName}`;
    if (!actionCache.has(cacheKey)) {
      actionCache.set(cacheKey, loadGltf(new GLTFLoader(), url));
    }
    const gltf = await actionCache.get(cacheKey);
    const variant = prepareCharacter(gltf.scene, `${record.data.key}-${actionName}`, record.pose.userData.modelWidth || CHARACTER_SPAN / 3.18);
    variant.visible = false;
    record.pose.add(variant);
    const mixer = new THREE.AnimationMixer(variant);
    const clip = gltf.animations[0];
    if (!clip) throw new Error(`${url} 中没有可播放的动画`);
    const action = mixer.clipAction(clip);
    const result = { gltf, variant, mixer, action, listener: null };
    record.variants.set(actionName, result);
    return result;
  }

  async function playCharacterAction(record, actionName, now) {
    if (!targetVisible || record.busy || now - record.pose.userData.lastActionAt < ACTION_COOLDOWN_MS) return;
    record.busy = true;
    record.pose.userData.lastActionAt = now;
    try {
      const variant = await getActionVariant(record, actionName);
      if (stopped || !targetVisible) return;
      record.activeVariant = variant;
      record.base.visible = false;
      variant.variant.visible = true;
      variant.mixer.stopAllAction();
      variant.action.reset();
      variant.action.setLoop(THREE.LoopOnce, 1);
      variant.action.clampWhenFinished = true;
      variant.listener = (event) => {
        if (event.action !== variant.action) return;
        variant.mixer.removeEventListener('finished', variant.listener);
        variant.listener = null;
        variant.action.stop();
        variant.variant.visible = false;
        record.base.visible = true;
        record.activeVariant = null;
        record.busy = false;
      };
      variant.mixer.addEventListener('finished', variant.listener);
      variant.action.play();
    } catch (error) {
      record.busy = false;
      console.warn(`[WebAR] ${record.data.key} ${actionName} animation failed`, error);
    }
  }

  function getScreenTargets(camera) {
    return characters.map((record) => {
      const height = record.pose.userData.modelHeight;
      const width = record.base.userData.modelWidth;
      const head = new THREE.Vector3(0, height * 0.79, 0);
      const body = new THREE.Vector3(0, height * 0.42, 0);
      const top = new THREE.Vector3(0, height, 0);
      const headBoundary = new THREE.Vector3(0, height * (2 / 3), 0);
      const headLeft = new THREE.Vector3(-width * 0.58, height * 0.84, 0);
      const headRight = new THREE.Vector3(width * 0.58, height * 0.84, 0);
      const bottom = new THREE.Vector3(0, 0, 0);
      const bodyLeft = new THREE.Vector3(-width * 0.68, height * 0.5, 0);
      const bodyRight = new THREE.Vector3(width * 0.68, height * 0.5, 0);
      record.pose.localToWorld(head);
      record.pose.localToWorld(body);
      record.pose.localToWorld(top);
      record.pose.localToWorld(headBoundary);
      record.pose.localToWorld(headLeft);
      record.pose.localToWorld(headRight);
      record.pose.localToWorld(bottom);
      record.pose.localToWorld(bodyLeft);
      record.pose.localToWorld(bodyRight);
      return {
        record,
        head: projectPoint(head, camera),
        body: projectPoint(body, camera),
        headTop: projectPoint(top, camera),
        headBoundary: projectPoint(headBoundary, camera),
        headLeft: projectPoint(headLeft, camera),
        headRight: projectPoint(headRight, camera),
        bottom: projectPoint(bottom, camera),
        bodyLeft: projectPoint(bodyLeft, camera),
        bodyRight: projectPoint(bodyRight, camera),
      };
    });
  }

  function hitCharacter(point, screenTargets, headOnly = false) {
    let best = null;
    let bestDistance = Infinity;
    for (const target of screenTargets) {
      const left = Math.min(target[headOnly ? 'headLeft' : 'bodyLeft'].x, target[headOnly ? 'headRight' : 'bodyRight'].x);
      const right = Math.max(target[headOnly ? 'headLeft' : 'bodyLeft'].x, target[headOnly ? 'headRight' : 'bodyRight'].x);
      const top = headOnly ? target.headTop.y : Math.min(target.headTop.y, target.bottom.y);
      const bottom = headOnly ? target.headBoundary.y : Math.max(target.headTop.y, target.bottom.y);
      if (point.x < left - 0.018 || point.x > right + 0.018 || point.y < top - 0.018 || point.y > bottom + 0.018) continue;
      const center = headOnly ? target.head : target.body;
      const distance = distance2D(point, center);
      if (distance < bestDistance) {
        best = target;
        bestDistance = distance;
      }
    }
    return best;
  }

  function selectNearest(point, screenTargets, key, maxDistance) {
    let best = null;
    let bestDistance = maxDistance;
    for (const target of screenTargets) {
      const distance = distance2D(point, target[key]);
      if (distance < bestDistance) {
        best = target;
        bestDistance = distance;
      }
    }
    return best;
  }

  function processHandLandmarks(result, now, video, bounds, camera) {
    const landmarks = result.landmarks?.[0];
    if (!landmarks?.[8]) {
      if (now - lastHandSeenAt > HAND_MISS_RESET_MS) {
        handTrail = [];
        previousHandPoint = null;
        patGesture = null;
        for (const record of characters) record.pose.userData.touchStartedAt = null;
      }
      return;
    }

    lastHandSeenAt = now;
    const point = pointInViewport(landmarks[8], video, bounds);
    if (!point || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return;
    const screenTargets = getScreenTargets(camera);

    handTrail.push({ ...point, time: now });
    handTrail = handTrail.filter((sample) => now - sample.time <= 420);
    if (handTrail.length < 2) {
      previousHandPoint = { ...point, time: now };
      return;
    }

    const start = handTrail[0];
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const duration = now - start.time;
    const distance = Math.hypot(dx, dy);
    const headTarget = hitCharacter(point, screenTargets, true);
    if (headTarget) {
      if (!patGesture || patGesture.record !== headTarget.record) {
        patGesture = { record: headTarget.record, strokeStartX: point.x, direction: 0, strokeCount: 0 };
      } else {
        const targetWidth = Math.abs(headTarget.headRight.x - headTarget.headLeft.x);
        const strokeThreshold = Math.max(0.018, targetWidth * 0.12);
        const strokeDx = point.x - patGesture.strokeStartX;
        if (Math.abs(strokeDx) >= strokeThreshold) {
          const direction = Math.sign(strokeDx);
          if (patGesture.direction && direction !== patGesture.direction) patGesture.strokeCount += 1;
          else if (!patGesture.direction) patGesture.strokeCount = 1;
          patGesture.direction = direction;
          patGesture.strokeStartX = point.x;
          if (patGesture.strokeCount >= 3) {
            void playCharacterAction(patGesture.record, 'pat', now);
            patGesture = { record: patGesture.record, strokeStartX: point.x, direction: 0, strokeCount: 0 };
          }
        }
      }
    } else {
      patGesture = null;
    }

    if (duration >= 65 && duration <= 420 && distance > 0.06) {
      const midpoint = { x: (point.x + start.x) / 2, y: (point.y + start.y) / 2 };
      if (Math.abs(dy) > Math.abs(dx) * 1.25) {
        const target = hitCharacter(midpoint, screenTargets);
        if (target) {
          void playCharacterAction(target.record, 'pull', now);
          handTrail = [{ ...point, time: now }];
        }
      }
    }

    if (previousHandPoint) {
      const stepX = point.x - previousHandPoint.x;
      const stepY = point.y - previousHandPoint.y;
      const stepTime = Math.max(now - previousHandPoint.time, 1);
      const stepDistance = Math.hypot(stepX, stepY);
      const stepMidpoint = { x: (point.x + previousHandPoint.x) / 2, y: (point.y + previousHandPoint.y) / 2 };
      const stepSpeed = stepDistance / stepTime;
      const trailSpeed = distance / Math.max(duration, 1);
      if (!headTarget && Math.abs(stepX) > Math.abs(stepY) * 1.15 && stepDistance > 0.004 && stepSpeed <= TURN_SPEED_MAX && trailSpeed <= TURN_SPEED_MAX) {
        const target = hitCharacter(stepMidpoint, screenTargets);
        if (target) {
          const pose = target.record.pose;
          pose.userData.turnAngle = THREE.MathUtils.clamp(
            pose.userData.turnAngle + stepX * TURN_RADIANS_PER_SCREEN_WIDTH,
            -Math.PI * 1.5,
            Math.PI * 1.5,
          );
          pose.userData.lastTurnGestureAt = now;
        }
      }
    }
    previousHandPoint = { ...point, time: now };
  }

  async function startHandTracking() {
    const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_URL);
    return HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.55,
      minHandPresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
    });
  }

  async function start() {
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      throw new Error('摄像头需要 HTTPS 安全来源。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('此浏览器不支持摄像头访问。');
    }

    // Ask for optional microphone access from the same explicit Start AR action.
    // AR remains usable if the user denies microphone permission.
    blowDetectorTask = startBlowDetector((durationMs) => {
      if (!targetVisible || stopped) return;
      for (const record of characters) {
        const turns = THREE.MathUtils.clamp(0.4 + (durationMs - 180) / 1400, 0.4, 1);
        record.pose.userData.blowSpinVelocity = turns * Math.PI * 2 * 5;
        record.pose.userData.lastTurnGestureAt = performance.now();
      }
      ui.blowDetected?.();
    }).then((detector) => {
      if (stopped) void detector.stop();
      else blowDetector = detector;
    }).catch((error) => {
      console.info('[WebAR] Microphone blow interaction is unavailable; AR remains active.', error);
    });

    const wasmFiles = [
      'vision_wasm_internal.js',
      'vision_wasm_internal.wasm',
      'vision_wasm_module_internal.js',
      'vision_wasm_module_internal.wasm',
      'vision_wasm_nosimd_internal.js',
      'vision_wasm_nosimd_internal.wasm',
    ];
    const assetUrls = [
      TARGET_URL,
      HAND_MODEL_URL,
      ...wasmFiles.map((file) => `${MEDIAPIPE_WASM_URL}/${file}`),
      ...CHARACTERS.flatMap((character) => [character.model, character.pat, character.pull]),
    ];
    await Promise.all(assetUrls.map((url, index) => assertAssetAvailable(url, `AR 资源 ${index + 1}`)));

    const fbxLoader = new FBXLoader();
    const models = await Promise.all(CHARACTERS.map((character) => loadFbx(fbxLoader, character.model)));

    mindar = new MindARThree({
      container,
      imageTargetSrc: TARGET_URL,
      maxTrack: 1,
      filterMinCF: 0.001,
      filterBeta: 0.01,
      warmupTolerance: 5,
      missTolerance: 5,
    });

    const { renderer, scene, camera } = mindar;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

    // FBXLoader imports the character's Blender materials as light-dependent
    // Phong materials. Without scene lights the entire model renders black,
    // hiding the white face details in camera-based AR.
    scene.add(new THREE.AmbientLight(0xffffff, 1.35));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(-0.4, 1.2, 1.8);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xdaf8e5, 0.65);
    fillLight.position.set(0.8, 0.5, -1);
    scene.add(fillLight);

    const anchor = mindar.addAnchor(0);
    const row = new THREE.Group();
    row.name = 'image-target-ground-plane-characters';
    row.position.set(0, -0.485, 0.06);
    row.visible = false;
    anchor.group.add(row);

    const targetWidth = CHARACTER_SPAN / 3.18;
    const spacing = CHARACTER_SPAN / 3;
    characters = models.map((model, index) => makeCharacterRecord(model, CHARACTERS[index], index, spacing, targetWidth, row));

    anchor.onTargetFound = () => {
      if (stopped) return;
      targetVisible = true;
      row.visible = true;
      ui.found();
    };
    anchor.onTargetLost = () => {
      if (stopped) return;
      targetVisible = false;
      row.visible = false;
      handTrail = [];
      previousHandPoint = null;
      patGesture = null;
      ui.lost();
    };

    await mindar.start();
    handLandmarkerTask = startHandTracking()
      .then((task) => {
        if (stopped) task.close();
        else {
          handLandmarker = task;
          ui.handTracking?.(true);
        }
        return task;
      })
      .catch((error) => {
        console.warn('[WebAR] Hand tracking is unavailable; image tracking remains active.', error);
        ui.handTracking?.(false, error);
        return null;
      });

    renderer.setAnimationLoop((now) => {
      const time = now / 1000;
      const deltaSeconds = lastRenderAt ? Math.min((now - lastRenderAt) / 1000, 0.05) : 0;
      lastRenderAt = now;
      for (const record of characters) {
        const { pose } = record;
        if (pose.userData.blowSpinVelocity > 0.05) {
          pose.userData.turnAngle += pose.userData.blowSpinVelocity * deltaSeconds;
          pose.userData.blowSpinVelocity *= Math.exp(-5 * deltaSeconds);
          pose.userData.lastTurnGestureAt = now;
          if (pose.userData.blowSpinVelocity <= 0.05) {
            pose.userData.blowSpinVelocity = 0;
            // Start easing home as soon as the blow-triggered spin finishes.
            pose.userData.lastTurnGestureAt = now - TURN_RETURN_DELAY_MS;
          }
        }
        const phase = time * 1.65 + pose.userData.floatPhase;
        pose.position.y = pose.userData.baseY + Math.sin(phase) * FLOAT_AMPLITUDE;
        const breath = 1 + (Math.sin(phase * 0.82 + 0.4) + 1) * 0.5 * BREATH_AMPLITUDE;
        pose.scale.set(breath, 1 + (breath - 1) * 0.68, breath);

        if (now - pose.userData.lastTurnGestureAt >= TURN_RETURN_DELAY_MS) {
          pose.userData.turnAngle *= Math.exp(-deltaSeconds / 0.55);
          if (Math.abs(pose.userData.turnAngle) < 0.005) pose.userData.turnAngle = 0;
        }
        pose.rotation.y = pose.userData.turnAngle;
        if (record.activeVariant) record.activeVariant.mixer.update(deltaSeconds);
      }

      if (targetVisible && handLandmarker && mindar.video?.readyState >= 2 && now - lastHandFrameAt >= HAND_INTERVAL_MS) {
        lastHandFrameAt = now;
        try {
          const bounds = renderer.domElement.getBoundingClientRect();
          const result = handLandmarker.detectForVideo(mindar.video, now);
          processHandLandmarks(result, now, mindar.video, bounds, camera);
        } catch (error) {
          console.warn('[WebAR] Hand gesture inference failed.', error);
        }
      }
      renderer.render(scene, camera);
    });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    targetVisible = false;
    if (handLandmarker) handLandmarker.close();
    if (blowDetector) await blowDetector.stop();
    blowDetector = null;
    if (mindar) {
      mindar.renderer.setAnimationLoop(null);
      mindar.stop();
      for (const record of characters) {
        for (const { mixer, variant } of record.variants.values()) {
          mixer.stopAllAction();
          variant.traverse((object) => {
            if (!object.isMesh) return;
            object.geometry.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach((material) => material?.dispose());
          });
        }
        record.pose.traverse((object) => {
          if (!object.isMesh) return;
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material?.dispose());
        });
      }
      mindar.renderer.dispose();
    }
    container.replaceChildren();
    characters = [];
    actionCache.clear();
    handLandmarker = null;
    mindar = null;
  }

  return { start, stop };
}
