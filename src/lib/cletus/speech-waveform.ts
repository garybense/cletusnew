import { float32ToPcm16Base64, type LiveVoicePreset } from "./nvidia-inference";

export interface WaveformMetrics {
  rms: number;
  peak: number;
  dominantBand: number;
  centroid: number;
}

const VOICE_PITCH_HZ: Record<LiveVoicePreset, number> = {
  Aria: 218,
  Sofia: 204,
  Jason: 126,
  Leo: 138,
  Mia: 232,
};

/**
 * Downsample linear FFT byte bins (0..255 from Web Audio AnalyserNode.getByteFrequencyData)
 * into `bandCount` perceptually spaced bands weighted toward human speech formants (~110 Hz - 4.8 kHz).
 */
export function downsampleFrequencyBins(
  bins: ArrayLike<number>,
  bandCount: number,
  sampleRate = 24000,
): number[] {
  const count = Math.max(1, Math.floor(bandCount));
  const len = bins.length;
  if (len === 0) {
    return new Array<number>(count).fill(0);
  }

  const nyquist = Math.max(4000, sampleRate / 2);
  const minHz = 95;
  const maxHz = Math.min(nyquist * 0.88, 5600);
  const bands = new Array<number>(count).fill(0);

  for (let b = 0; b < count; b++) {
    const t0 = b / count;
    const t1 = (b + 1) / count;
    // Perceptual logarithmic frequency mapping so vocal formants span across all bands
    const hz0 = minHz * Math.pow(maxHz / minHz, t0);
    const hz1 = minHz * Math.pow(maxHz / minHz, t1);
    const idx0 = Math.max(0, Math.min(len - 1, Math.floor((hz0 / nyquist) * len)));
    const idx1 = Math.max(idx0 + 1, Math.min(len, Math.ceil((hz1 / nyquist) * len)));

    let sum = 0;
    let peak = 0;
    let items = 0;
    for (let i = idx0; i < idx1; i++) {
      const raw = Number(bins[i] ?? 0);
      const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(255, raw)) / 255 : 0;
      sum += clamped;
      if (clamped > peak) peak = clamped;
      items += 1;
    }

    const avg = items > 0 ? sum / items : 0;
    // Blend average and peak energy, suppress sub-floor hiss, apply gentle speech compression
    const blended = avg * 0.58 + peak * 0.42;
    const gated = blended <= 0.035 ? 0 : (blended - 0.035) / 0.965;
    bands[b] = Number(Math.min(1, Math.pow(gated * 1.15, 0.78)).toFixed(4));
  }

  return bands;
}

/**
 * Synthesize realistic vocal-formant spectral bands when browser speechSynthesis fallback is active
 * (where OS engines do not expose raw PCM to Web Audio AnalyserNode), driven by real `onboundary` impulses.
 */
export function synthesizeSpeechCadenceBands(params: {
  bandCount: number;
  elapsedMs: number;
  lastBoundaryAtMs: number;
  nowMs: number;
  syllableSeed: number;
  speaking: boolean;
}): number[] {
  const count = Math.max(1, Math.floor(params.bandCount));
  if (!params.speaking) {
    return new Array<number>(count).fill(0);
  }

  const timeSec = Math.max(0, params.elapsedMs) / 1000;
  const msSinceBoundary = Math.max(0, params.nowMs - params.lastBoundaryAtMs);
  // Word boundary impulse decays smoothly over ~280ms; baseline syllable oscillator sustains between boundaries
  const boundaryImpulse =
    params.lastBoundaryAtMs > 0 ? Math.exp(-msSinceBoundary / 185) : 0.45;
  const syllablePulse =
    0.42 +
    0.34 * Math.max(0, Math.sin(timeSec * 11.4 + params.syllableSeed * 0.7)) +
    0.24 * Math.max(0, Math.cos(timeSec * 5.8 + params.syllableSeed * 1.3));
  const envelope = Math.min(1, 0.28 + boundaryImpulse * 0.48 + syllablePulse * 0.36);

  // Two moving vocal formant centers (F1 low-mid, F2 mid-high) + crisp sibilant tail
  const f1Center = 0.22 + 0.09 * Math.sin(timeSec * 4.3 + params.syllableSeed);
  const f2Center = 0.56 + 0.14 * Math.cos(timeSec * 3.1 + params.syllableSeed * 0.5);
  const f3Center = 0.82 + 0.08 * Math.sin(timeSec * 7.2);

  const bands = new Array<number>(count).fill(0);
  for (let b = 0; b < count; b++) {
    const pos = count === 1 ? 0.5 : b / (count - 1);
    const f1 = Math.exp(-Math.pow((pos - f1Center) / 0.16, 2)) * 0.92;
    const f2 = Math.exp(-Math.pow((pos - f2Center) / 0.18, 2)) * 0.76;
    const f3 = Math.exp(-Math.pow((pos - f3Center) / 0.13, 2)) * (0.28 + 0.35 * boundaryImpulse);
    const microRipple = 0.84 + 0.16 * Math.sin(timeSec * 17 + b * 1.45);
    const energy = Math.min(1, (f1 + f2 + f3) * envelope * microRipple);
    bands[b] = Number(energy.toFixed(4));
  }

  return bands;
}

/**
 * Asymmetric envelope smoothing across animation frames: fast attack for crisp transients,
 * smooth release back toward baseline.
 */
export function smoothBandFrame(
  prev: readonly number[],
  next: readonly number[],
  attack = 0.62,
  release = 0.24,
): number[] {
  const len = next.length;
  const out = new Array<number>(len).fill(0);
  for (let i = 0; i < len; i++) {
    const p = Number(prev[i] ?? 0);
    const n = Math.max(0, Math.min(1, Number(next[i] ?? 0)));
    const coef = n >= p ? attack : release;
    const val = p + (n - p) * coef;
    out[i] = val < 0.004 ? 0 : Number(Math.min(1, val).toFixed(4));
  }
  return out;
}

export function computeWaveformMetrics(bands: readonly number[]): WaveformMetrics {
  const len = bands.length;
  if (len === 0) {
    return { rms: 0, peak: 0, dominantBand: 0, centroid: 0 };
  }

  let sumSq = 0;
  let peak = 0;
  let dominantBand = 0;
  let weightedSum = 0;
  let totalMag = 0;

  for (let i = 0; i < len; i++) {
    const v = Math.max(0, Math.min(1, Number(bands[i] ?? 0)));
    sumSq += v * v;
    if (v > peak) {
      peak = v;
      dominantBand = i;
    }
    const normIdx = len === 1 ? 0.5 : i / (len - 1);
    weightedSum += v * normIdx;
    totalMag += v;
  }

  return {
    rms: Number(Math.sqrt(sumSq / len).toFixed(4)),
    peak: Number(peak.toFixed(4)),
    dominantBand,
    centroid: totalMag > 0 ? Number((weightedSum / totalMag).toFixed(4)) : 0,
  };
}

/**
 * Generate a clean multi-syllable 24 kHz PCM16 harmonic speech-cadence test phrase
 * for auditioning Cletus's Web Audio playback + real-time AnalyserNode D3 waveform.
 */
export function synthesizeVoiceCheckPcm16Base64(
  voiceName: LiveVoicePreset = "Aria",
  sampleRate = 24000,
): string {
  const basePitch = VOICE_PITCH_HZ[voiceName] ?? 218;
  const durationSec = 1.65;
  const totalSamples = Math.floor(sampleRate * durationSec);
  const float32 = new Float32Array(totalSamples);

  // Four crisp vocal-like formant bursts with realistic spectral variance
  const syllables = [
    { start: 0.02, end: 0.34, pitchMult: 1.0, f2Hz: 940, f3Hz: 2150 },
    { start: 0.40, end: 0.74, pitchMult: 1.14, f2Hz: 1620, f3Hz: 2820 },
    { start: 0.82, end: 1.18, pitchMult: 0.96, f2Hz: 1180, f3Hz: 2440 },
    { start: 1.24, end: 1.60, pitchMult: 1.06, f2Hz: 2040, f3Hz: 3180 },
  ];

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (const syl of syllables) {
      if (t < syl.start || t > syl.end) continue;
      const localT = (t - syl.start) / (syl.end - syl.start);
      // Smooth Hann-like syllable amplitude envelope
      const env = Math.sin(Math.PI * localT);
      const f0 = basePitch * syl.pitchMult * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * t));
      const f1 = f0 * 2.15;
      sample +=
        env *
        (0.42 * Math.sin(2 * Math.PI * f0 * t) +
          0.26 * Math.sin(2 * Math.PI * f1 * t) +
          0.16 * Math.sin(2 * Math.PI * syl.f2Hz * t) +
          0.08 * Math.sin(2 * Math.PI * syl.f3Hz * t));
    }
    float32[i] = Math.max(-0.85, Math.min(0.85, sample * 0.72));
  }

  return float32ToPcm16Base64(float32);
}
