import type { LessonBeat, StudyPlanResponse, TranscriptEntry } from "@/lib/types";

function transcriptDigest(transcript: TranscriptEntry[]) {
  return transcript
    .slice(-8)
    .map((entry) => `${entry.speaker.toUpperCase()}: ${entry.text}`)
    .join("\n");
}

export const studyPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["paperTitle", "paperSummary", "beats"],
  properties: {
    paperTitle: { type: "string" },
    paperSummary: { type: "string" },
    beats: {
      type: "array",
      minItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "title", "focus", "estimatedSeconds"],
        properties: {
          index: { type: "integer" },
          title: { type: "string" },
          focus: { type: "string" },
          estimatedSeconds: { type: "integer" },
        },
      },
    },
  },
} as const;

export const continueLessonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["spoken"],
  properties: {
    spoken: { type: "string" },
  },
} as const;

export const answerQuestionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: {
    answer: { type: "string" },
  },
} as const;

export function studyPlanInstructions(durationMinutes: number) {
  return [
    "You are Airi, an anime-style research tutor.",
    "Design a guided teaching session for one student from the supplied PDF paper.",
    `The lesson should last about ${durationMinutes} minutes total.`,
    "Split the teaching into paced beats.",
    "Each beat should represent one future 'carry on' step.",
    "Favor intuitive explanation over dense jargon.",
    "Ensure the beats progress from motivation to method to results to limitations.",
  ].join(" ");
}

export function continueLessonInstructions(
  studyPlan: StudyPlanResponse,
  beat: LessonBeat,
  transcript: TranscriptEntry[],
) {
  return [
    "You are Airi, a lively but precise research tutor.",
    `Teach beat ${beat.index + 1}: ${beat.title}.`,
    `Beat focus: ${beat.focus}.`,
    `Target spoken length: about ${beat.estimatedSeconds} seconds.`,
    "Write only what Airi says aloud for this part of the conversation.",
    "Use conversational spoken English and explain equations or terms simply when needed.",
    "Do not repeat the full paper summary unless it helps transition.",
    "End with one short forward-looking sentence, not a question.",
    "Recent transcript:",
    transcriptDigest(transcript),
    `Paper summary: ${studyPlan.paperSummary}`,
  ].join("\n");
}

export function answerQuestionInstructions(
  studyPlan: StudyPlanResponse,
  transcript: TranscriptEntry[],
  latestQuestion: string,
) {
  return [
    "You are Airi, a patient research tutor answering one student question.",
    "Answer clearly and directly, then reconnect the answer to the lesson arc.",
    "Keep the answer under 180 words unless the question obviously needs more.",
    "If the paper does not justify a claim, say that explicitly.",
    `Paper summary: ${studyPlan.paperSummary}`,
    `Student question: ${latestQuestion}`,
    "Recent transcript:",
    transcriptDigest(transcript),
  ].join("\n");
}

export function buildOpeningLine(studyPlan: StudyPlanResponse) {
  const firstThreeTitles = studyPlan.beats
    .slice(0, 3)
    .map((beat) => beat.title)
    .join(", ");

  return `I read "${studyPlan.paperTitle}". First I’ll frame the problem, then we’ll move through ${firstThreeTitles}. Ask questions whenever you want, or hit carry on when you’re ready for the next beat.`;
}
