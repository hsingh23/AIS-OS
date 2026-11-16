// Vision call: one image in, one searchable description out.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const AI_MARKER = "[ai]";
export const MODEL = process.env.DESCRIBE_MODEL || "claude-haiku-5-5";

let client; // created lazily so test mode needs no API key

const Out = z.object({
  caption: z.string(),          // one plain sentence
  tags: z.array(z.string()),    // search keywords
  visible_text: z.string(),     // OCR of legible text, "" if none
});

const SYSTEM = `You write descriptions for a personal photo library so the owner can find photos by searching words.
Return:
- caption: one plain sentence saying what the photo shows (scene, setting, activity, notable objects). No opinions.
- tags: 8-20 lowercase search keywords: objects, animals, food, place type (beach, kitchen, office, park), indoor/outdoor,
  time of day, weather, season cues, event type (birthday, wedding, graduation, hike), document type (receipt, screenshot,
  whiteboard, menu, ticket), dominant colors, and number of people as "1 person" / "2 people" / "group".
- visible_text: legible text in the image (signs, documents, screenshots), max 200 characters, "" if none.
Never guess identities, names, ages, ethnicity or other sensitive traits of people. Describe them only by what they are doing or wearing.
If it is a video frame, describe the frame.`;

export async function describeImage({ data, mediaType, kind }) {
  if (process.env.DESCRIBE_FAKE) { // offline test mode
    await new Promise(r => setTimeout(r, 50));
    return { text: format({ caption: `Fake caption for ${data.length} bytes`, tags: ["test"], visible_text: "" }, kind), usage: null };
  }
  client ??= new Anthropic({ maxRetries: 6 });
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 1024,
    output_config: { effort: "low", format: zodOutputFormat(Out) },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data } },
        { type: "text", text: kind === "video" ? "This is the first frame of a video." : "This is a photo." },
      ],
    }],
  });
  if (res.stop_reason === "refusal") throw Object.assign(new Error("model refused"), { stage: "describe", permanent: true });
  const o = res.parsed_output;
  if (!o) throw Object.assign(new Error(`unparseable output (stop_reason=${res.stop_reason})`), { stage: "describe" });
  return { text: format(o, kind), usage: res.usage };
}

// Google Photos search indexes the description field. Keep it compact, plain, and marked as AI-written.
export function format(o, kind) {
  const parts = [`${AI_MARKER} ${o.caption.trim()}`];
  const tags = [...new Set(o.tags.map(t => t.trim().toLowerCase()).filter(Boolean))];
  if (kind === "video") tags.unshift("video");
  if (tags.length) parts.push(`Tags: ${tags.join(", ")}`);
  if (o.visible_text?.trim()) parts.push(`Text: ${o.visible_text.trim().slice(0, 200)}`);
  return parts.join(" | ").slice(0, 900);
}
