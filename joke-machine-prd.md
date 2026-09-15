# Joke Machine — PRD (working title)
**Type:** Software web app, portfolio/IxD case study
**Owner:** Jason Saputra
**Status:** Draft v0.1 — for discussion

---

## 1. Concept

A talking joke machine with a face. Press a button, it tells you a joke — spoken aloud, in a voice, by an animated character — with control over joke length and an optional call-and-response mode ("Why did the chicken cross the road?" / "I don't know, why?").

The core interaction bet: **a joke lands differently when it's performed rather than read.** Timing, voice, and a face reacting to its own punchline are doing real comedic work that plain text can't. That's the thing worth testing and documenting for the case study.

---

## 2. Core Features

| # | Feature | Notes |
|---|---|---|
| 1 | Tell a joke on button press | LLM-generated on the fly, not a static database |
| 2 | Length control | Toggle/slider: short (one-liner) vs. long (setup + buildup + punchline) |
| 3 | Spoken delivery | ElevenLabs TTS, voice selectable from ElevenLabs voice library |
| 4 | Call-and-response mode (optional/stretch) | Bot delivers setup, waits, user prompts punchline via button (or speech later) |
| 5 | Talking face | Animated character synced to audio while speaking |

---

## 3. Interaction Flow

**Standard mode:**
1. User presses "Tell me a joke"
2. Face shows a brief "thinking" state (LLM call in flight)
3. Joke text is generated (length param applied)
4. TTS audio is generated/streamed
5. Face animates (mouth syncs to ElevenLabs character timing data) while the line plays
6. Face does a reaction beat after the punchline (finger-guns + self-satisfied nod) — this is a huge part of the "delight," worth investing polish here
7. Idle state until next press

**Call-and-response mode:**
1. User presses "Tell me a joke" with call-and-response toggled on
2. LLM is prompted to generate a joke in question-answer format specifically
3. Bot speaks the setup line only, then face goes to a "waiting" pose
4. User presses "I don't know, tell me!" (v1) — or says it via mic (stretch goal, needs STT)
5. Bot speaks the punchline, face reacts

---

## 4. Character — Dad Joke Robot (resolved)

**Personality:** genuinely, earnestly convinced every joke is a banger, zero self-awareness about how groan-worthy it is. Delivers punchlines with theatrical pride, waits a beat too long for a reaction, wins either way (groan or laugh). Dad mannerisms translated into robot behavior — finger-guns, self-satisfied nod, an occasional "...get it?" on the worst ones.

**Visual direction:** simple geometric/HUD-style robot face (fits existing visual language: grunge/Y2K, streetwear, game-HUD influence) with one or two minimal dad signifiers layered on top — a pixelated mustache glyph, tiny dad-hat icon, or a single Hawaiian-shirt-pattern accent. Keep it to one, so it reads as a design choice, not a costume gag.

**Voice:** warmer/older-leaning, slightly cheesy delivery, over-enunciates the punchline word, unbothered/unrushed pacing.

**Animation beats:** talking (setup) → tiny pause/lean-in ("wait for it") → punch-in emphasis + finger-guns (punchline) → self-satisfied nod, holds a beat (post-punchline, unbothered by your reaction either way).

## 5. Talking Face — Technical Approach

Recommend **not** a photoreal or video-based face — an animated SVG/canvas character is cheaper to build, more controllable, and fits a distinct visual identity (good for the case study).

- **Lip sync — primary approach:** ElevenLabs' `/v1/text-to-speech/{voice_id}/with-timestamps` endpoint (streaming version also available) returns character-level start/end timing for every character spoken, generated in the same call that produces the voice audio. Map vowel characters to mouth-open frames and consonants/spaces to closed/small — solid sync with far less engineering than analyzing raw audio, since the timing is exact rather than inferred.
- **Fallback / reference if timestamp-based sync isn't enough:** [lipsync-engine](https://github.com/Amoner/lipsync-engine) — zero-dependency, browser-native, real-time viseme detection via AudioWorklet + Web Audio API, ships with an SVG mouth renderer. [HeadAudio](https://github.com/kyr0/HeadAudio) — MIT licensed, in-browser audio-driven viseme detection, no transcript needed, works with any TTS output.
- **Expression states:** idle/blink loop, thinking, talking, pre-punchline lean-in, punchline-reaction (finger-guns + nod), waiting (call-and-response).
- **Open-source references to borrow ideas (not dependencies) from:**
  - [Animated-Robot-Face](https://github.com/shanukaamalsha/Animated-Robot-Face) — closest visual match: glowing borders, cube-like eyes that track the cursor, expressions inspired by Emo/Vector-style cute robots. Good reference for the eye/expression system.
  - [emofani](https://github.com/steffenwittig/emofani) — academic human-robot-interaction face project; the useful idea is giving the idle state signs of "being alive" (blinking, breathing, micro-movements) so the character feels present between jokes, not just reactive.
  - [Tipsy](https://github.com/RohithLabs/Clipzy) — procedural SVG avatar studio (Vue3/TS) with a clean animation-state-machine structure (idle, thinking, wink, alert, etc.) — useful structural reference for organizing our own state machine.
- **Recommendation:** build the face as a small custom React component with its own state machine, driven by ElevenLabs' character timing data — not a full external library dependency. Character is simple enough (geometric HUD face, not a rigged 3D avatar) that a custom build stays lightweight and is cleaner to document as original design work for the case study.

---

## 6. Joke Generation

- LLM API call (Claude or GPT) with a system prompt tuned for joke quality + a length parameter.
- Length toggle maps to a prompt instruction, not separate content sources — e.g. "one-liner, under 20 words" vs. "longer joke with a setup and a buildup before the punchline."
- Call-and-response mode uses a distinct prompt template that forces strict Q/A joke format (not all jokes fit that shape).
- **Content safety (resolved):** system prompt explicitly constrains jokes to friendly/family-safe territory — no harmful, offensive, or targeted content. Since this is public-facing for the portfolio, worth a light server-side check as a second layer (e.g. simple keyword/category flag with a re-roll) rather than relying on the system prompt alone.
- **Open question:** do you want a lightweight repetition guard (e.g. keep last N jokes in session state, ask the model to avoid repeats) so a demo/testing session doesn't serve the same joke twice?

---

## 7. Voice

- ElevenLabs TTS API, using the `with-timestamps` endpoint (see Section 5) so the same call powers both audio and lip sync.
- Voice should be chosen deliberately for the dad-bot personality — warmer/older-leaning, slightly cheesy delivery, unbothered pacing, not a flat narrator voice. Recommend browsing the ElevenLabs voice library and shortlisting 2-3 candidates to test against the same joke before locking one in.
- **Usage limit + fallback (resolved):** ElevenLabs usage is capped at a daily limit, enforced server-side in the API route (not just client-side UI). Once the daily limit is hit, the app falls back to [edge-tts](https://github.com/rany2/edge-tts) — a free, open-source library that uses Microsoft Edge's online TTS service, no API key required. Use the Node.js port ([@travisvn/edge-tts](https://github.com/travisvn/edge-tts)) to fit directly into the Next.js stack. Won't match the ElevenLabs voice exactly, but should land close enough in character.
  - Bonus: edge-tts can export subtitle/timing data (`.srt`/`.vtt`) alongside the audio, so the fallback path can keep feeding the face real timing data too — lip sync doesn't have to degrade just because the voice provider switched.
- **Open questions:** exact daily quota number (global cap, or per-session/IP); fixed voice vs. a voice picker as a user-facing feature.

---

## 8. Accessibility & Latency Handling

- **Captions:** the joke text is always shown on screen, not just spoken — non-negotiable, not an add-on. Covers anyone Deaf/hard-of-hearing and anyone with sound off.
- **Mute toggle** and full **keyboard navigation** (not click-only) for the whole interaction.
- **Filler audio during delay (resolved):** a small set of pre-recorded filler mp3s in the dad-bot's voice/character (e.g. "hang on, good one coming...", "one sec, thinking...") play only if the LLM/TTS response is taking longer than a set threshold — avoids dead air or a frozen face during a slow API call. Recommend recording these once with the chosen ElevenLabs voice (they're static lines, so no per-use API cost) and reusing them as local audio assets.
- **Failure state:** if the LLM or TTS call errors out or times out entirely (not just slow), show an explicit graceful fallback (e.g. "brain's a little slow, try again") rather than a silent broken state.
- **Autoplay:** initialize the audio context on the button-press gesture itself (browsers block audio without a user gesture) — not before.

---

## 9. Tech Stack

- **Frontend:** React (Vite or Next.js) — consistent with your Cursor + Grok 4.5 workflow
- **Backend:** Lightweight serverless API routes (Next.js API routes or similar) — needed so the LLM and ElevenLabs API keys aren't exposed client-side, and where the daily usage cap + fallback switch are enforced
- **TTS + lip-sync timing:** ElevenLabs `with-timestamps` API (primary), [@travisvn/edge-tts](https://github.com/travisvn/edge-tts) (free fallback once daily limit is hit, also provides timing via subtitle export)
- **Joke gen:** Claude or OpenAI API
- **Face rendering:** SVG or `<canvas>`, React-driven state machine for expressions (idle, talking, lean-in, punchline-reaction, waiting) — custom-built, referencing Animated-Robot-Face, emofani, and Tipsy for ideas (see Section 5)
- **Hosting:** Vercel

---

## 10. Phased Rollout

**Phase 1 — Core loop (no voice, no face)**
Button → LLM joke → text on screen. Length toggle working. Validates prompt quality and length control.

**Phase 2 — Voice**
Add ElevenLabs TTS. Joke text is spoken. No face animation yet (static character or none).

**Phase 3 — Face**
Add animated face with audio-synced mouth + reaction states. This is where most of the "delight" work lives.

**Phase 4 — Call-and-response + polish**
Add the Q/A mode, voice selection (if going with picker), repetition guard, visual polish.

**Phase 5 — Case study documentation**
Write up the research angle below, capture demo footage, possibly a short informal usability round.

---

## 11. Research Questions (for the case study)

- Does hearing a joke performed (voice + face) land as funnier / more delightful than reading the same joke as text?
- Does the reaction beat (face laughing at its own punchline) meaningfully affect perceived personality/warmth of the machine?
- Does the call-and-response format increase engagement/delight over passive one-shot delivery, or does it just add friction?
- What's the acceptable latency between button press and joke delivery before it breaks comedic timing?

---

## 12. Open Questions to Resolve Before Building

1. ~~Character/visual design direction for the face~~ — resolved: dad joke robot (Section 4)
2. Fixed voice vs. voice-picker feature
3. Call-and-response input: button-only (v1) or speech-to-text (stretch)
4. Repetition guard needed or not
5. Daily ElevenLabs usage cap — exact number, and global vs. per-session/IP
6. Project name

---

*Next step: resolve open questions above, then move into Phase 1 build in Cursor.*
