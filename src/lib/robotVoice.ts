/**
 * Turns a plain spoken voice into a robot one, in the browser.
 *
 * The source stays a natural "dad" recording — everything mechanical about
 * the result is added here, so the words remain intelligible while the
 * timbre goes metallic.
 */

export interface RobotVoiceChain {
  input: AudioNode;
  analyser: AnalyserNode;
  start: () => void;
  stop: () => void;
}

/** Soft-clipping curve — adds grit without turning the voice to mush. */
function makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

export function buildRobotVoice(ctx: AudioContext): RobotVoiceChain {
  const input = ctx.createGain();

  // Ring modulation is the core of the effect: multiplying the voice by a low
  // sine carrier splits it into metallic sidebands. Setting the gain to 0 and
  // driving it with an oscillator makes the gain swing -1..1, which is a true
  // multiply rather than plain tremolo.
  const ring = ctx.createGain();
  ring.gain.value = 0;
  const carrier = ctx.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = 48;
  carrier.connect(ring.gain);

  // The mix is mostly dry. Ring mod is a seasoning here, not the dish — too
  // much wet and its sub-fundamental sidebands make the voice muddy and dark.
  const dry = ctx.createGain();
  dry.gain.value = 0.88;
  const wet = ctx.createGain();
  wet.gain.value = 0.26;

  const drive = ctx.createWaveShaper();
  drive.curve = makeDriveCurve(3.5);
  drive.oversample = "2x";

  // Keep the low end (fundamental is near 110Hz) and leave more top on than a
  // telephone filter would — the boxiness was reading as heavy-handed.
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 105;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 5400;
  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 1900;
  presence.Q.value = 2.5;
  presence.gain.value = 2.5;

  // A very short feedback delay rings like a metal enclosure — just a hint.
  const comb = ctx.createDelay(0.05);
  comb.delayTime.value = 0.0055;
  const combFeedback = ctx.createGain();
  combFeedback.gain.value = 0.16;
  const combMix = ctx.createGain();
  combMix.gain.value = 0.18;

  // Master trim. Nudged up slightly from 0.42 because the softer drive stage
  // no longer adds the loudness that clipping was contributing.
  const out = ctx.createGain();
  out.gain.value = 0.5;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;

  input.connect(dry);
  input.connect(ring);
  ring.connect(wet);
  dry.connect(drive);
  wet.connect(drive);
  drive.connect(hp);
  hp.connect(lp);
  lp.connect(presence);
  presence.connect(out);
  presence.connect(comb);
  comb.connect(combFeedback);
  combFeedback.connect(comb);
  comb.connect(combMix);
  combMix.connect(out);
  out.connect(analyser);
  analyser.connect(ctx.destination);

  return {
    input,
    analyser,
    start: () => carrier.start(),
    stop: () => {
      try {
        carrier.stop();
      } catch {
        // already stopped
      }
    },
  };
}
