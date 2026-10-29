// The wing beat: a soft sound when mail leaves the outbox (Settings → Notifications, off by default). Made with Web
// Audio from filtered noise, two short strokes like a wing, so there is no sound file to ship.

let ctx: AudioContext | null = null;

function stroke(at: number, gain: number) {
  if (!ctx) return;
  const length = Math.floor(ctx.sampleRate * 0.16);
  const noise = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = noise;
  // A band that sweeps down: air pushed, not a hiss.
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.9;
  band.frequency.setValueAtTime(1400, at);
  band.frequency.exponentialRampToValueAtTime(380, at + 0.15);
  const level = ctx.createGain();
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(gain, at + 0.03);
  level.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
  source.connect(band).connect(level).connect(ctx.destination);
  source.start(at);
  source.stop(at + 0.17);
}

export function wingBeat() {
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime + 0.01;
    stroke(now, 0.12);
    stroke(now + 0.19, 0.08);
  } catch {
    // No audio device: stay quiet.
  }
}
