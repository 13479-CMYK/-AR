import * as THREE from 'three';
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js';

const BASE_URL = import.meta.env.BASE_URL;
const TARGET_URL = `${BASE_URL}targets/school-logo.mind`;
const IDLE_FPS = 8;
const JUMP_FPS = 10;
const CHARACTER_WIDTH = 0.3;
const CHARACTER_HEIGHT = CHARACTER_WIDTH * (630 / 740);

const idleUrls = Array.from({ length: 8 }, (_, index) =>
  `${BASE_URL}characters/idle/idle${index + 1}.png`);
const jumpUrls = Array.from({ length: 55 }, (_, index) =>
  `${BASE_URL}characters/jump/jump${String(index + 1).padStart(2, '0')}.png`);

async function assertTargetAvailable() {
  const response = await fetch(TARGET_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`识别目标文件加载失败（HTTP ${response.status}）：${TARGET_URL}`);
  }
  const type = response.headers.get('content-type') || '';
  if (type.includes('text/html')) {
    throw new Error(`识别目标文件无效或不存在：${TARGET_URL}`);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`动画帧加载失败：${url}`));
    image.src = url;
  });
}

function makeButtonTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgba(4, 20, 12, 0.9)';
  context.strokeStyle = '#56ee91';
  context.lineWidth = 8;
  context.beginPath();
  context.roundRect(8, 8, 496, 144, 54);
  context.fill();
  context.stroke();
  context.fillStyle = '#effff4';
  context.font = '800 66px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('JUMP', 256, 84);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export function createARSession({ container, ui }) {
  let mindar = null;
  let character = null;
  let jumpButton = null;
  let characterTexture = null;
  let buttonTexture = null;
  let animationCanvas = null;
  let animationContext = null;
  let idleFrames = [];
  let jumpFrames = [];
  let animationName = 'idle';
  let animationStartedAt = 0;
  let lastFrameIndex = -1;
  let targetVisible = false;
  let stopped = false;
  let pointerHandler = null;

  function drawFrame(frame) {
    animationContext.clearRect(0, 0, animationCanvas.width, animationCanvas.height);
    animationContext.drawImage(frame, 0, 0, animationCanvas.width, animationCanvas.height);
    characterTexture.needsUpdate = true;
  }

  function playJump(now = performance.now()) {
    if (!targetVisible || animationName === 'jump') return;
    animationName = 'jump';
    animationStartedAt = now;
    lastFrameIndex = -1;
  }

  function updateAnimation(now) {
    const frames = animationName === 'jump' ? jumpFrames : idleFrames;
    const fps = animationName === 'jump' ? JUMP_FPS : IDLE_FPS;
    const elapsed = Math.max(0, now - animationStartedAt);
    let frameIndex = Math.floor((elapsed * fps) / 1000);

    if (animationName === 'jump' && frameIndex >= frames.length) {
      animationName = 'idle';
      animationStartedAt = now;
      frameIndex = 0;
      lastFrameIndex = -1;
    } else if (animationName === 'idle') {
      frameIndex %= frames.length;
    }

    if (frameIndex !== lastFrameIndex && frames[frameIndex]) {
      drawFrame(frames[frameIndex]);
      lastFrameIndex = frameIndex;
    }
  }

  async function start() {
    if (!window.isSecureContext && location.hostname !== 'localhost') {
      throw new Error('摄像头需要 HTTPS 安全来源。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('此浏览器不支持摄像头访问。');
    }
    await assertTargetAvailable();
    [idleFrames, jumpFrames] = await Promise.all([
      Promise.all(idleUrls.map(loadImage)),
      Promise.all(jumpUrls.map(loadImage)),
    ]);

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

    animationCanvas = document.createElement('canvas');
    animationCanvas.width = 740;
    animationCanvas.height = 630;
    animationContext = animationCanvas.getContext('2d', { alpha: true });
    animationContext.imageSmoothingEnabled = false;
    characterTexture = new THREE.CanvasTexture(animationCanvas);
    characterTexture.colorSpace = THREE.SRGBColorSpace;
    characterTexture.minFilter = THREE.NearestFilter;
    characterTexture.magFilter = THREE.NearestFilter;

    const anchor = mindar.addAnchor(0);
    character = new THREE.Mesh(
      new THREE.PlaneGeometry(CHARACTER_WIDTH, CHARACTER_HEIGHT),
      new THREE.MeshBasicMaterial({
        map: characterTexture,
        transparent: true,
        alphaTest: 0.02,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    character.position.set(0, 0.025, 0.02);
    character.renderOrder = 2;
    character.visible = false;
    anchor.group.add(character);

    buttonTexture = makeButtonTexture();
    jumpButton = new THREE.Mesh(
      new THREE.PlaneGeometry(0.13, 0.041),
      new THREE.MeshBasicMaterial({
        map: buttonTexture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    jumpButton.position.set(0, -0.145, 0.025);
    jumpButton.renderOrder = 3;
    jumpButton.visible = false;
    anchor.group.add(jumpButton);

    drawFrame(idleFrames[0]);
    animationStartedAt = performance.now();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    pointerHandler = (event) => {
      if (!targetVisible || animationName === 'jump') return;
      const bounds = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
      pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.intersectObject(jumpButton, false).length > 0) {
        event.preventDefault();
        playJump();
      }
    };
    renderer.domElement.addEventListener('pointerup', pointerHandler, { passive: false });

    anchor.onTargetFound = () => {
      if (stopped) return;
      targetVisible = true;
      character.visible = true;
      jumpButton.visible = true;
      ui.found();
    };
    anchor.onTargetLost = () => {
      if (stopped) return;
      targetVisible = false;
      character.visible = false;
      jumpButton.visible = false;
      ui.lost();
    };

    await mindar.start();
    renderer.setAnimationLoop((now) => {
      if (character?.visible) updateAnimation(now);
      renderer.render(scene, camera);
    });
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (mindar) {
      mindar.renderer.setAnimationLoop(null);
      if (pointerHandler) {
        mindar.renderer.domElement.removeEventListener('pointerup', pointerHandler);
      }
      mindar.stop();
      character?.geometry.dispose();
      character?.material.dispose();
      jumpButton?.geometry.dispose();
      jumpButton?.material.dispose();
      characterTexture?.dispose();
      buttonTexture?.dispose();
      mindar.renderer.dispose();
    }
    container.replaceChildren();
    idleFrames = [];
    jumpFrames = [];
    mindar = null;
    character = null;
    jumpButton = null;
  }

  return { start, stop };
}
