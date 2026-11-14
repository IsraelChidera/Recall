import { z } from "zod";

/**
 * The Claude data export as observed in a real export (manifest version 1.0,
 * November 2026). Anthropic does not document this format, so every field
 * beyond the identifiers is optional and unknown keys are ignored.
 *
 * conversations.json is an array of conversations. Each has `chat_messages`,
 * and every message carries both a flat `text` and a `content` array of typed
 * blocks (text, thinking, tool_use, tool_result, document, image,
 * injected_prompt_block). Messages form a tree through `parent_message_uuid`:
 * edits and regenerations appear as sibling branches.
 */
const lenientString = z.string().nullish().catch(null);

const rawContentBlockSchema = z
  .object({
    type: lenientString,
    text: lenientString,
  })
  .catch({ type: null, text: null });

export const rawMessageSchema = z.object({
  uuid: z.string().min(1),
  sender: lenientString,
  text: lenientString,
  created_at: lenientString,
  parent_message_uuid: lenientString,
  content: z.array(rawContentBlockSchema).nullish().catch(null),
  attachments: z.array(z.unknown()).nullish().catch(null),
  files: z.array(z.unknown()).nullish().catch(null),
});

export const rawConversationSchema = z.object({
  uuid: z.string().min(1),
  name: lenientString,
  summary: lenientString,
  created_at: lenientString,
  updated_at: lenientString,
  chat_messages: z.array(z.unknown()).nullish().catch(null),
});

export type RawMessage = z.infer<typeof rawMessageSchema>;
export type RawConversation = z.infer<typeof rawConversationSchema>;
