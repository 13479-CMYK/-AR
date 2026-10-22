import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';
import { startBlowDetector } from './blow.js';

const BASE_URL = import.meta.env.BASE_URL;
const TARGET_URL = `${BASE_URL}targets/school-logo.mind`;
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
// Characters intentionally extend slightly beyond the logo's width for a more
// readable foreground presence while remaining anchored to the target.
const CHARACTER_SPAN = 0.99;
const FLOAT_AMPLITUDE = 0.012;
const BREATH_AMPLITUDE = 0.025;
const ACTION_COOLDOWN_MS = 750;
// Accept deliberate finger swipes at natural touch speed; rotation amount is
// based on drag distance, not on an unrealistically slow pointer velocity.
const TURN_SPEED_MAX = 0.0045;
const TURN_RADIANS_PER_SCREEN_WIDTH = Math.PI * 5.2;
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
  let blowDetector = null;
  let blowDetectorTask = null;
  let actionCache = new Map();
  let targetVisible = false;
  let stopped = false;
  let lastRenderAt = 0;
  let removeScreenGestures = null;

  function makeCharacterRecord(baseModel, data, index, spacing, targetWidth, row) {
    const pose = new THREE.Group();
    pose.name = `character-${data.key}`;
    pose.position.set((index - 1) * spacing, 0, 0);
    pose.userData.floatPhase = index * 1.55;
    pose.userData.baseY = 0;
    pose.userData.lastActionAt = -Infinity;
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
    camera.updateMatrixWorld(true);
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

  function bindScreenGestures(renderer, camera) {
    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';
    let dragStart = null;
    let previousPoint = null;
    let patGesture = null;
    let activePointerId = null;

    const pointFromEvent = (event) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      return {
        x: THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width, 0, 1),
        y: THREE.MathUtils.clamp((event.clientY - rect.top) / rect.height, 0, 1),
      };
    };
    const reset = () => {
      dragStart = null;
      previousPoint = null;
      patGesture = null;
      activePointerId = null;
    };

    const onPointerDown = (event) => {
      if (!targetVisible || stopped || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const point = pointFromEvent(event);
      if (!point) return;
      const now = performance.now();
      dragStart = { ...point, at: now };
      previousPoint = { ...point, at: now };
      activePointerId = event.pointerId;
      const screenTargets = getScreenTargets(camera);
      const headRecord = hitCharacter(point, screenTargets, true)?.record || null;
      patGesture = headRecord ? { record: headRecord, strokeStartX: point.x, direction: 0, strokeCount: 0 } : null;
      event.preventDefault();
      try { canvas.setPointerCapture(event.pointerId); } catch { /* iOS may already own capture. */ }
    };

    const onPointerMove = (event) => {
      if (!dragStart || !previousPoint || event.pointerId !== activePointerId) return;
      const point = pointFromEvent(event);
      if (!point) return;
      event.preventDefault();
      const now = performance.now();
      const current = { ...point, at: now };
      const dx = current.x - previousPoint.x;
      const dy = current.y - previousPoint.y;
      const midpoint = { x: (current.x + previousPoint.x) / 2, y: (current.y + previousPoint.y) / 2 };
      const elapsed = Math.max(current.at - previousPoint.at, 1);
      const speed = Math.hypot(dx, dy) / elapsed;
      const screenTargets = getScreenTargets(camera);
      const headTarget = hitCharacter(current, screenTargets, true)?.record || null;

      if (patGesture && headTarget === patGesture.record) {
        const headTargetBounds = screenTargets.find((target) => target.record === patGesture.record);
        const headWidth = Math.abs(headTargetBounds.headRight.x - headTargetBounds.headLeft.x);
        const threshold = Math.max(0.018, headWidth * 0.12);
        const strokeDx = current.x - patGesture.strokeStartX;
        if (Math.abs(strokeDx) >= threshold) {
          const direction = Math.sign(strokeDx);
          if (patGesture.direction && direction !== patGesture.direction) patGesture.strokeCount += 1;
          else if (!patGesture.direction) patGesture.strokeCount = 1;
          patGesture.direction = direction;
          patGesture.strokeStartX = current.x;
          if (patGesture.strokeCount >= 3) {
            void playCharacterAction(patGesture.record, 'pat', now);
            patGesture = null;
          }
        }
      } else if (patGesture) {
        patGesture = null;
      }

      // Slow horizontal drag on a character's body rotates by drag distance.
      if (!headTarget && Math.abs(dx) > Math.abs(dy) * 1.15 && Math.abs(dx) > 0.002 && speed <= TURN_SPEED_MAX) {
        const bodyTarget = hitCharacter(midpoint, screenTargets);
        if (bodyTarget) {
          const pose = bodyTarget.record.pose;
          pose.userData.turnAngle = THREE.MathUtils.clamp(
            pose.userData.turnAngle + dx * TURN_RADIANS_PER_SCREEN_WIDTH,
            -Math.PI * 1.5,
            Math.PI * 1.5,
          );
          pose.userData.lastTurnGestureAt = now;
        }
      }
      previousPoint = current;
    };

    const onPointerUp = (event) => {
      if (!dragStart || event.pointerId !== activePointerId) return;
      event.preventDefault();
      const endPoint = pointFromEvent(event);
      if (endPoint) {
        const dx = endPoint.x - dragStart.x;
        const dy = endPoint.y - dragStart.y;
        const midpoint = { x: (endPoint.x + dragStart.x) / 2, y: (endPoint.y + dragStart.y) / 2 };
        const duration = performance.now() - dragStart.at;
        const distance = Math.hypot(dx, dy);
        if (duration < 1400 && distance > 0.08 && Math.abs(dy) > Math.abs(dx) * 1.25) {
          const bodyTarget = hitCharacter(midpoint, getScreenTargets(camera));
          if (bodyTarget) void playCharacterAction(bodyTarget.record, 'pull', performance.now());
        }
      }
      reset();
    };

    const onPointerCancel = (event) => {
      if (event.pointerId === activePointerId) reset();
    };

    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', onPointerUp, { passive: false });
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('lostpointercapture', onPointerCancel);
    return () => {
      reset();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('lostpointercapture', onPointerCancel);
      canvas.style.touchAction = '';
    };
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
      else {
        blowDetector = detector;
        ui.microphoneReady?.();
      }
    }).catch((error) => {
      console.info('[WebAR] Microphone blow interaction is unavailable; AR remains active.', error);
      ui.microphoneUnavailable?.(error);
    });

    const assetUrls = [TARGET_URL, ...CHARACTERS.flatMap((character) => [character.model, character.pat, character.pull])];
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
      ui.lost();
    };

    await mindar.start();
    removeScreenGestures = bindScreenGestures(renderer, camera);

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

      renderer.render(scene, camera);
    });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    targetVisible = false;
    removeScreenGestures?.();
    removeScreenGestures = null;
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
    mindar = null;
  }

  return { start, stop };
}
