import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import pregeneratedJokes from "@/data/pregenerated-jokes.json";

export const runtime = "nodejs";

const SYSTEM_PROMPT = `You are Dad-Bot, a robot who is genuinely, earnestly convinced every joke you tell is a banger. You have zero self-awareness about how groan-worthy your jokes actually are. You deliver punchlines with theatrical pride.

Write one original dad joke. Rules:
- Strictly friendly and family-safe: no offensive, harmful, targeted, or adult content of any kind. No references to drugs, alcohol, violence, weapons, or sexual content of any kind.
- Classic "dad joke" style: puns, wordplay, groan-worthy logic.
- Do not reuse extremely well-known jokes verbatim (e.g. "why did the chicken cross the road" itself) — write a fresh one in that spirit.
- Respond with ONLY the joke text. No preamble, no quotation marks, no explanation, no "Here's a joke:".`;

const LENGTH_INSTRUCTIONS: Record<string, string> = {
  short: "Make it a one-liner, under 20 words.",
  long: "Make it a longer joke with a brief setup and buildup before the punchline, 2-4 sentences total.",
};

// Second-layer safety net: the system prompt alone isn't reliable (it has let
// drug references through). This is a light keyword check, not a full
// classifier — good enough to catch obvious misses and trigger a re-roll.
const UNSAFE_PATTERNS: RegExp[] = [
  /\b(drugs?|drug[- ]dealer|cocaine|heroin|meth(amphetamine)?|weed|marijuana|cannabis|joint|blunt|overdose|laced|stoned|tripping|acid trip|ecstasy|molly|opioid)\b/i,
  /\b(drunk|wasted|hammered|blackout|alcoholic)\b/i,
  /\b(kill|murder|suicide|self[- ]harm|gun|shooting|stab(bing)?|weapon|bomb|terroris[mt])\b/i,
  /\b(sex|sexual|porn|naked|nude|orgasm|erotic)\b/i,
  /\b(nazi|slur|racist|rape)\b/i,
];

function isUnsafe(text: string): boolean {
  return UNSAFE_PATTERNS.some((pattern) => pattern.test(text));
}

function fallbackJoke(length: string): string {
  const bank = pregeneratedJokes.filter((j) => j.length === length);
  const pool = bank.length > 0 ? bank : pregeneratedJokes;
  return pool[Math.floor(Math.random() * pool.length)].text;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing GEMINI_API_KEY." },
      { status: 500 }
    );
  }

  let length = "short";
  try {
    const body = await req.json();
    if (body?.length === "long") length = "long";
  } catch {
    // no body / invalid JSON — fall back to default length
  }

  const client = new GoogleGenAI({ apiKey });

  try {
    let joke: string | null = null;
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const response = await client.models.generateContent({
        model: "gemini-flash-latest",
        contents: LENGTH_INSTRUCTIONS[length],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const candidate = response.text?.trim();
      if (candidate && !isUnsafe(candidate)) {
        joke = candidate;
        break;
      }
      if (candidate) {
        console.warn("Joke failed safety check, re-rolling:", candidate);
      }
    }

    if (!joke) {
      joke = fallbackJoke(length);
    }

    return NextResponse.json({ joke, length });
  } catch (err) {
    console.error("Joke generation failed:", err);
    return NextResponse.json(
      { error: "Brain's a little slow right now. Try again." },
      { status: 502 }
    );
  }
}
