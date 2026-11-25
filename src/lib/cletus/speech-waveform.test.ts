import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pcm16Base64ToFloat32 } from "./nvidia-inference";
import {
  computeWaveformMetrics,
  downsampleFrequencyBins,
  smoothBandFrame,
  synthesizeSpeechCadenceBands,
  synthesizeVoiceCheckPcm16Base64,
} from "./speech-waveform";

describe("speech-waveform spectral engine", () => {
  it("maps silent FFT byte bins cleanly to zeroed frequency bands", () => {
    const bins = new Uint8Array(128).fill(0);
    const bands = downsampleFrequencyBins(bins, 24, 24000);
    assert.equal(bands.length, 24);
    assert.ok(bands.every((v) => v === 0));
  });

  it("distributes vocal formant energy across logarithmic frequency bands", () => {
    const bins = new Uint8Array(128).fill(0);
    // Simulate vocal fundamental (~220 Hz -> bin ~2) + F2 formant (~1800 Hz -> bin ~19)
    bins[2] = 210;
    bins[3] = 195;
    bins[18] = 225;
    bins[19] = 240;

    const bands = downsampleFrequencyBins(bins, 24, 24000);
    const metrics = computeWaveformMetrics(bands);

    assert.equal(bands.length, 24);
    assert.ok(metrics.peak > 0.75, `expected high peak from formant energy, got ${metrics.peak}`);
    assert.ok(metrics.rms > 0.15, `expected non-trivial RMS, got ${metrics.rms}`);
    assert.ok(metrics.centroid > 0.15 && metrics.centroid < 0.85);
  });

  it("applies faster attack than release smoothing", () => {
    const zero = [0, 0, 0, 0];
    const spike = [0.9, 0.7, 0.5, 0.3];
    const attacked = smoothBandFrame(zero, spike, 0.65, 0.2);
    assert.ok(attacked[0]! > 0.55);

    const released = smoothBandFrame(attacked, zero, 0.65, 0.2);
    assert.ok(released[0]! < attacked[0]!);
    assert.ok(released[0]! > 0.4);
  });

  it("synthesizes speech cadence bands responsive to boundary impulses and resets when silent", () => {
    const active = synthesizeSpeechCadenceBands({
      bandCount: 20,
      elapsedMs: 420,
      lastBoundaryAtMs: 9950,
      nowMs: 10000,
      syllableSeed: 3,
      speaking: true,
    });
    const decayed = synthesizeSpeechCadenceBands({
      bandCount: 20,
      elapsedMs: 420,
      lastBoundaryAtMs: 9000,
      nowMs: 10000,
      syllableSeed: 3,
      speaking: true,
    });
    const silent = synthesizeSpeechCadenceBands({
      bandCount: 20,
      elapsedMs: 420,
      lastBoundaryAtMs: 9950,
      nowMs: 10000,
      syllableSeed: 3,
      speaking: false,
    });

    assert.ok(computeWaveformMetrics(active).rms > computeWaveformMetrics(decayed).rms);
    assert.ok(silent.every((v) => v === 0));
  });

  it("generates valid non-silent 24kHz PCM16 audio for voice check", () => {
    const b64 = synthesizeVoiceCheckPcm16Base64("Aria", 24000);
    const pcm = pcm16Base64ToFloat32(b64);
    assert.ok(pcm.length >= 24000);
    let maxAbs = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = Math.abs(pcm[i]!);
      if (v > maxAbs) maxAbs = v;
    }
    assert.ok(maxAbs > 0.3 && maxAbs <= 0.9, `expected normalized audio peak, got ${maxAbs}`);
  });
});
