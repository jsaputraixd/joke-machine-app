"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import styles from "./page.module.css";
import type { RobotState } from "@/components/DadBotScene";
import { buildRobotVoice, type RobotVoiceChain } from "@/lib/robotVoice";

const DadBotScene = dynamic(() => import("@/components/DadBotScene"), { ssr: false });

type Length = "short" | "long";
type Status = "idle" | "loading" | "error";

export default function Home() {
  const [length, setLength] = useState<Length>("short");
  const [joke, setJoke] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [robotState, setRobotState] = useState<RobotState>("idle");

  const bubbleWrapRef = useRef<HTMLDivElement>(null);
  const bubbleInnerRef = useRef<HTMLDivElement>(null);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const mouthLevelRef = useRef(0);
  const mouthRafRef = useRef<number | null>(null);
  const speakingRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const chainRef = useRef<RobotVoiceChain | null>(null);

  function clearTimers() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }

  function schedule(fn: () => void, delay: number) {
    timers.current.push(setTimeout(fn, delay));
  }

  function stopMouthLoop() {
    speakingRef.current = false;
    if (mouthRafRef.current !== null) {
      cancelAnimationFrame(mouthRafRef.current);
      mouthRafRef.current = null;
    }
    mouthLevelRef.current = 0;
  }

  function stopVoice() {
    if (sourceRef.current) {
      try {
        sourceRef.current.onended = null;
        sourceRef.current.stop();
      } catch {
        // already stopped
      }
      sourceRef.current = null;
    }
    if (chainRef.current) {
      chainRef.current.stop();
      chainRef.current = null;
    }
    stopMouthLoop();
  }

  function startMouthLoop() {
    speakingRef.current = true;
    const tick = (now: number) => {
      if (!speakingRef.current) return;
      mouthLevelRef.current = 0.3 + 0.7 * Math.abs(Math.sin(now / 90));
      mouthRafRef.current = requestAnimationFrame(tick);
    };
    mouthRafRef.current = requestAnimationFrame(tick);
  }

  function runSyntheticMouthLoop(durationMs: number): Promise<void> {
    return new Promise((resolve) => {
      startMouthLoop();
      setTimeout(() => {
        stopMouthLoop();
        resolve();
      }, durationMs);
    });
  }

  async function playVoice(text: string): Promise<void> {
    stopVoice();

    try {
      const res = await fetch("/api/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error("Speech request failed");
      const arrayBuffer = await res.arrayBuffer();

      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") await ctx.resume();

      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      // Slightly slower, which also drops the pitch a little further.
      source.playbackRate.value = 0.92;

      const chain = buildRobotVoice(ctx);
      source.connect(chain.input);
      sourceRef.current = source;
      chainRef.current = chain;

      const data = new Uint8Array(chain.analyser.frequencyBinCount);

      await new Promise<void>((resolve) => {
        source.onended = () => {
          stopMouthLoop();
          chain.stop();
          if (sourceRef.current === source) sourceRef.current = null;
          resolve();
        };

        // Mouth follows the actual waveform, so it matches what you hear.
        const tick = () => {
          chain.analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          mouthLevelRef.current = Math.min(1, Math.sqrt(sum / data.length) * 4);
          mouthRafRef.current = requestAnimationFrame(tick);
        };

        speakingRef.current = true;
        chain.start();
        source.start();
        tick();
      });
    } catch (err) {
      console.warn("Voice unavailable, using fallback mouth animation:", err);
      await runSyntheticMouthLoop(Math.min(6000, Math.max(1200, text.length * 55)));
    }
  }

  async function tellJoke() {
    clearTimers();
    stopVoice();
    setStatus("loading");
    setErrorMessage(null);
    setRobotState("thinking");

    try {
      const res = await fetch("/api/joke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ length }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "Something went wrong.");
      }

      setJoke(data.joke);
      setStatus("idle");
      setRobotState("talking");

      await playVoice(data.joke);

      setRobotState("leanIn");
      schedule(() => setRobotState("punchline"), 300);
      schedule(() => setRobotState("idle"), 300 + 1700);
    } catch (err) {
      setStatus("error");
      setRobotState("idle");
      setErrorMessage(
        err instanceof Error ? err.message : "Brain's a little slow right now. Try again."
      );
    }
  }

  // The bubble is anchored at a 3D point beside Dad-Bot's head and only grows
  // rightward/upward from there (see .bubbleWrap). A short joke rarely gets
  // big enough to notice; a long one wraps to several lines — tall enough to
  // push its top edge above the viewport — and can also run past the right
  // edge, especially with him rotated toward the left. This measures the
  // bubble every frame and nudges it back on-screen via CSS vars, rather than
  // trying to guess a safe anchor offset up front — the anchor's actual
  // screen position moves continuously as the camera orbits, so a one-time
  // layout check wouldn't stay correct.
  useEffect(() => {
    let rafId: number;
    const EDGE_MARGIN = 16;

    const clamp = () => {
      const wrap = bubbleWrapRef.current;
      const inner = bubbleInnerRef.current;
      if (wrap && inner) {
        // Reset first so the measurement reflects the anchor position, not
        // last frame's correction — otherwise small errors compound.
        wrap.style.setProperty("--bubble-shift-x", "0px");
        wrap.style.setProperty("--bubble-shift-y", "0px");
        const rect = inner.getBoundingClientRect();

        let shiftX = 0;
        if (rect.right > window.innerWidth - EDGE_MARGIN) {
          shiftX = window.innerWidth - EDGE_MARGIN - rect.right;
        } else if (rect.left < EDGE_MARGIN) {
          shiftX = EDGE_MARGIN - rect.left;
        }

        // Grows upward, so the failure mode is the top running off-screen —
        // push it down. (A bottom check is included too, in case the anchor
        // itself is ever moved low enough for that to matter.)
        let shiftY = 0;
        if (rect.top < EDGE_MARGIN) {
          shiftY = EDGE_MARGIN - rect.top;
        } else if (rect.bottom > window.innerHeight - EDGE_MARGIN) {
          shiftY = window.innerHeight - EDGE_MARGIN - rect.bottom;
        }

        wrap.style.setProperty("--bubble-shift-x", `${shiftX}px`);
        wrap.style.setProperty("--bubble-shift-y", `${shiftY}px`);
      }
      rafId = requestAnimationFrame(clamp);
    };

    rafId = requestAnimationFrame(clamp);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const bubble = (
    <div ref={bubbleWrapRef} className={styles.bubbleWrap}>
      <div
        ref={bubbleInnerRef}
        className={`${styles.bubble} ${status === "error" ? styles.bubbleError : ""}`}
        aria-live="polite"
      >
        {status === "loading" && (
          <p className={styles.thinking}>
            thinking<span className={styles.dots}>...</span>
          </p>
        )}
        {status === "error" && <p className={styles.errorText}>{errorMessage}</p>}
        {status === "idle" && joke && <p className={styles.jokeText}>{joke}</p>}
        {status === "idle" && !joke && (
          <p className={styles.placeholder}>press the button on my chest.</p>
        )}
      </div>
    </div>
  );

  return (
    <main className={styles.page}>
      <div className={styles.sceneLayer}>
        <DadBotScene
          state={robotState}
          mouthLevelRef={mouthLevelRef}
          busy={status === "loading"}
          onTellJoke={tellJoke}
          bubble={bubble}
        />
      </div>

      <div className={styles.overlay}>
        <div className={styles.header}>
          <div className={styles.kicker}>JOKE MACHINE</div>
          <h1 className={styles.title}>DAD-BOT</h1>
        </div>

        <div className={styles.bottomBar}>
          <button
            type="button"
            className={styles.srButton}
            onClick={tellJoke}
            disabled={status === "loading"}
          >
            {status === "loading" ? "One sec..." : "Tell me a joke"}
          </button>

          <div className={styles.lengthToggle} role="radiogroup" aria-label="Joke length">
            <button
              type="button"
              role="radio"
              aria-checked={length === "short"}
              className={`${styles.toggleOption} ${length === "short" ? styles.toggleActive : ""}`}
              onClick={() => setLength("short")}
            >
              SHORT
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={length === "long"}
              className={`${styles.toggleOption} ${length === "long" ? styles.toggleActive : ""}`}
              onClick={() => setLength("long")}
            >
              LONG
            </button>
          </div>

          <div className={styles.hint}>
            press the button on his chest · drag to look around · scroll to zoom
          </div>

          <div className={styles.credit}>
            Office model{" "}
            <a
              href="https://sketchfab.com/3d-models/cartoon-office-7d7a64a1749c44deb8be233eb131b47e"
              target="_blank"
              rel="noreferrer noopener"
            >
              &ldquo;Cartoon Office&rdquo;
            </a>{" "}
            by scrawach
          </div>
        </div>
      </div>
    </main>
  );
}
