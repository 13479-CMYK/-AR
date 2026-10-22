export async function startBlowDetector(onBlow) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('此浏览器不支持麦克风输入');
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('此浏览器不支持 Web Audio');
  const context = new AudioContextClass();
  const resumeTask = context.resume();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false,
    });
    await resumeTask;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let ambient = 0.012;
  let loudSince = 0;
  let quietSince = 0;
  let lastBlowAt = -Infinity;
  let stopped = false;
  let timer = 0;

  const inspect = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    const threshold = Math.max(0.09, ambient * 4.5);
    const now = performance.now();

    if (rms >= threshold) {
      if (!loudSince) loudSince = now;
      quietSince = 0;
    } else if (loudSince && rms < threshold * 0.65) {
      if (!quietSince) quietSince = now;
      if (now - quietSince >= 120) {
        const duration = quietSince - loudSince;
        if (duration >= 150 && now - lastBlowAt >= 450) {
          lastBlowAt = now;
          onBlow?.(duration);
        }
        loudSince = 0;
        quietSince = 0;
      }
    } else {
      quietSince = 0;
    }
    if (!loudSince) {
      ambient = ambient * 0.96 + rms * 0.04;
    }
    timer = window.setTimeout(inspect, 40);
  };
  inspect();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(timer);
      source.disconnect();
      analyser.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
    },
  };
}
