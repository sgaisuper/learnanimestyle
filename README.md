# Airi Paper Tutor

![Airi Paper Tutor preview](public/image.png)

This is a focused MVP for the flow you described:

- upload an arXiv-style PDF
- generate an anime-style guided lesson from the paper
- show Airi's transcript on screen
- ask questions by typing
- tell her to carry on through the next lesson beat

## Stack

- Next.js App Router
- OpenAI Responses API for PDF-aware analysis
- OpenAI TTS for spoken playback
- Web Audio API loudness tracking for VRM mouth animation
- Three.js + `@pixiv/three-vrm` for the browser avatar

## Run

1. Install dependencies:

```bash
npm install
```

2. Add your API key:

```bash
copy .env.example .env.local
```

3. Start the app:

```bash
npm run dev
```

4. Open `http://localhost:3000`

5. Click `Start lesson` after choosing a PDF.

## Notes

- The backend uploads the PDF to OpenAI with `purpose: "user_data"` and asks `gpt-5` to plan and teach the lesson.
- The initial response creates the study plan only. Each `Carry on` generates the next spoken beat so the lesson length stays controllable.
- Spoken playback uses OpenAI TTS via `/api/tts`, with a feminine `shimmer` default voice and browser loudness analysis driving VRM mouth expressions in the canvas viewer.
- You can change the TTS voice with `OPENAI_TTS_VOICE` in `.env.local`.
- A bundled sample girl model is available at `public/vrm/AvatarSample_A.vrm` and loads by default.
- The avatar uses a small procedural idle pose in the browser: gentle sway, breathing, and arm settling on top of the neutral pose.
- This is an AIRI-style tutor shell, not the full `moeru-ai/airi` application.
