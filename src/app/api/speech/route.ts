import { NextRequest, NextResponse } from "next/server";
import { EdgeTTS } from "@travisvn/edge-tts";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const EDGE_TTS_VOICE = process.env.EDGE_TTS_VOICE || "en-US-ChristopherNeural";
// macOS built-in voice. "Alex" is the natural, mature male one — the robot
// character comes from the effects chain in the browser, not the voice itself.
const SAY_VOICE = process.env.SAY_VOICE || "Alex";

type Speech = { audio: ArrayBuffer; type: string };

/**
 * macOS `say`. Local, instant, no API key and no network — and unlike
 * speechSynthesis it hands back real audio the browser can run effects on.
 * Only available when the server itself is on macOS.
 */
async function trySay(text: string): Promise<Speech | null> {
  if (process.platform !== "darwin") return null;

  const out = join(tmpdir(), `dadbot-${randomUUID()}.wav`);
  try {
    // `say` reads [[...]] as inline speech commands, so strip any from the
    // joke text before prepending our own pitch setting.
    // pbas 39 drops Alex from ~172Hz to ~117Hz: deeper, still natural.
    const spoken = `[[pbas 39]] ${text.replace(/\[\[|\]\]/g, " ")}`;

    // execFile (no shell) — the text is an argv entry, never parsed as a command.
    await execFileAsync(
      "say",
      ["-v", SAY_VOICE, "-r", "168", "-o", out, "--data-format=LEI16@22050", spoken],
      { timeout: 15000 }
    );
    const buf = await readFile(out);
    const audio = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { audio: audio as ArrayBuffer, type: "audio/wav" };
  } catch (err) {
    console.warn("macOS say unavailable:", err);
    return null;
  } finally {
    await unlink(out).catch(() => {});
  }
}

async function tryElevenLabs(text: string): Promise<Speech | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) return null;

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn("ElevenLabs unavailable, falling back:", res.status, errText);
      return null;
    }

    return { audio: await res.arrayBuffer(), type: "audio/mpeg" };
  } catch (err) {
    console.warn("ElevenLabs request failed, falling back:", err);
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Kept only as a last resort for non-macOS hosts. Microsoft's endpoint has
// been hanging outright (it's an unofficial, reverse-engineered client), so
// this is behind the local path and capped tightly.
async function tryEdgeTts(text: string): Promise<Speech | null> {
  try {
    const tts = new EdgeTTS(text, EDGE_TTS_VOICE);
    const result = await withTimeout(tts.synthesize(), 6000);
    return { audio: await result.audio.arrayBuffer(), type: "audio/mpeg" };
  } catch (err) {
    console.error("edge-tts failed:", err);
    return null;
  }
}

export async function POST(req: NextRequest) {
  let text = "";
  try {
    const body = await req.json();
    if (typeof body?.text === "string") text = body.text;
  } catch {
    // no body / invalid JSON
  }

  if (!text.trim()) {
    return NextResponse.json({ error: "No text provided." }, { status: 400 });
  }

  // Local `say` goes first: it's instant and always available on this machine,
  // whereas ElevenLabs currently costs ~0.7s just to come back paywalled.
  // Swap the order if that account ever gets upgraded.
  const speech =
    (await trySay(text)) ?? (await tryElevenLabs(text)) ?? (await tryEdgeTts(text));

  if (!speech) {
    return NextResponse.json({ error: "Voice generation failed." }, { status: 502 });
  }

  return new NextResponse(speech.audio, {
    status: 200,
    headers: {
      "Content-Type": speech.type,
      "Cache-Control": "no-store",
    },
  });
}
