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
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let ambient = 0;
  let calibrationSamples = 0;
  let calibrated = false;
  let loudSince = 0;
  let quietSince = 0;
  let lastBlowAt = -Infinity;
  let peakRms = 0;
  let stopped = false;
  let timer = 0;

  const inspect = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    const now = performance.now();

    // Learn the room/device's idle noise floor first. A fixed RMS cutoff is
    // far too high for quiet microphones and too low in noisy environments.
    if (!calibrated) {
      ambient = calibrationSamples === 0 ? rms : ambient * 0.92 + rms * 0.08;
      calibrationSamples += 1;
      if (calibrationSamples >= 16) calibrated = true;
      timer = window.setTimeout(inspect, 35);
      return;
    }

    const relativeRise = rms - ambient;
    const threshold = Math.max(0.012, ambient * 1.75);

    if (relativeRise >= threshold) {
      if (!loudSince) {
        loudSince = now;
        peakRms = rms;
      }
      peakRms = Math.max(peakRms, rms);
      quietSince = 0;
    } else if (loudSince && relativeRise < threshold * 0.55) {
      if (!quietSince) quietSince = now;
      if (now - quietSince >= 180) {
        const duration = quietSince - loudSince;
        // Reject tiny clicks, but accept a short intentional puff.
        if (duration >= 220 && peakRms - ambient >= threshold * 1.35 && now - lastBlowAt >= 700) {
          lastBlowAt = now;
          onBlow?.(duration);
        }
        loudSince = 0;
        quietSince = 0;
        peakRms = 0;
      }
    } else {
      quietSince = 0;
    }
    if (!loudSince) {
      // Slow adaptation prevents sustained blowing from being absorbed as
      // ambient noise while still tracking gradual device/room noise changes.
      ambient = ambient * 0.995 + rms * 0.005;
    }
    timer = window.setTimeout(inspect, 35);
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
