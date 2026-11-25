import {
  downsampleFloat32,
  encodeFloat32ToWavBytes,
  mixAudioChannelsToMono,
} from "./nvidia-inference";

export function pickRecorderMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "audio/webm";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}

export async function prepareAudioBlobForAsr(
  blob: Blob,
  fallbackMimeType: string,
): Promise<{ audioBase64: string; mimeType: string }> {
  const rawBuffer = await blob.arrayBuffer();
  const AudioCtx =
    typeof window !== "undefined"
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;

  if (!AudioCtx) {
    return {
      audioBase64: bytesToBase64(new Uint8Array(rawBuffer)),
      mimeType: fallbackMimeType,
    };
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioCtx();
    const decoded = await ctx.decodeAudioData(rawBuffer.slice(0));
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      channels.push(decoded.getChannelData(ch));
    }
    const mono = mixAudioChannelsToMono(channels);
    const targetRate = 16000;
    const mono16k =
      decoded.sampleRate > targetRate
        ? downsampleFloat32(mono, decoded.sampleRate, targetRate)
        : mono;
    const effectiveRate = decoded.sampleRate > targetRate ? targetRate : decoded.sampleRate;
    const wavBytes = encodeFloat32ToWavBytes(mono16k, effectiveRate);
    return {
      audioBase64: bytesToBase64(wavBytes),
      mimeType: "audio/wav",
    };
  } catch {
    return {
      audioBase64: bytesToBase64(new Uint8Array(rawBuffer)),
      mimeType: fallbackMimeType,
    };
  } finally {
    if (ctx) {
      await ctx.close().catch(() => {});
    }
  }
}

export function getBrowserLatLng(): Promise<{ latitude: number; longitude: number } | undefined> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: Number(pos.coords.latitude.toFixed(6)),
          longitude: Number(pos.coords.longitude.toFixed(6)),
        });
      },
      () => resolve(undefined),
      { enableHighAccuracy: false, timeout: 4500, maximumAge: 120_000 },
    );
  });
}

/**
 * Compute perceptual 0..1 audio level from Web Audio time-domain samples (either Float32 [-1,1] or Uint8 [0,255]).
 */
export function computeNormalizedRmsLevel(
  samples: ArrayLike<number>,
  isByteTimeDomain = false,
): number {
  const len = samples.length;
  if (len === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const val = isByteTimeDomain ? (samples[i]! - 128) / 128 : samples[i]!;
    sumSq += val * val;
  }
  const rms = Math.sqrt(sumSq / len);
  if (!Number.isFinite(rms) || rms <= 0.004) return 0;
  // Boost quiet mic speech smoothly into 0..1 visual meter range
  return Math.min(1, Math.pow(rms * 3.8, 0.72));
}

