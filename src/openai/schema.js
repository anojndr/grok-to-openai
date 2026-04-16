import { z } from "zod";

const imageUrlObjectSchema = z
  .object({
    url: z.string().optional(),
    detail: z.string().optional(),
    file_id: z.string().optional()
  })
  .refine((value) => Boolean(value.url || value.file_id), {
    message: "image_url requires url or file_id"
  });

const imageUrlValueSchema = z.union([z.string(), imageUrlObjectSchema]);

const inputTextPart = z.object({
  type: z.enum(["input_text", "text", "output_text"]).default("input_text"),
  text: z.string()
});

const inputFilePart = z.object({
  type: z.literal("input_file"),
  file_id: z.string().optional(),
  file_url: z.string().url().optional(),
  file_data: z.string().optional(),
  filename: z.string().optional()
});

const inputImagePart = z.object({
  type: z.literal("input_image"),
  image_url: z.string().optional(),
  file_id: z.string().optional()
}).refine((value) => Boolean(value.image_url || value.file_id), {
  message: "input_image requires image_url or file_id"
});

const messageContentPart = z.union([inputTextPart, inputFilePart, inputImagePart]);

const messageInput = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(messageContentPart)])
});

const sourceAttributionSchema = z.object({
  inline_citations: z.boolean().optional(),
  include_sources: z.boolean().optional(),
  include_search_queries: z.boolean().optional()
});

export const responsesCreateSchema = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), messageInput, z.array(messageInput)]).optional(),
  instructions: z.string().optional(),
  previous_response_id: z.string().optional(),
  stream: z.boolean().optional(),
  store: z.boolean().optional(),
  metadata: z.record(z.string()).optional(),
  text: z
    .object({
      format: z
        .object({
          type: z.string().optional()
        })
        .optional()
    })
    .optional(),
  reasoning: z
    .object({
      effort: z.enum(["low", "medium", "high"]).optional()
    })
    .optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  truncation: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  conversation: z.string().optional(),
  source_attribution: sourceAttributionSchema.optional()
});

const chatTextPart = z.object({
  type: z.literal("text"),
  text: z.string()
});

const chatImagePart = z.object({
  type: z.literal("image_url"),
  image_url: imageUrlValueSchema.optional(),
  file_id: z.string().optional()
}).refine((value) => Boolean(value.file_id || value.image_url), {
  message: "image_url requires image_url or file_id"
});

const chatMessageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z
    .union([z.string(), z.array(z.union([chatTextPart, chatImagePart])), z.null()])
    .optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional()
});

export const chatCompletionsCreateSchema = z.object({
  model: z.string().optional(),
  messages: z.array(chatMessageSchema),
  stream: z.boolean().optional(),
  store: z.boolean().optional(),
  metadata: z.record(z.string()).optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  n: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  reasoning_effort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
    .optional(),
  response_format: z.unknown().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
  stream_options: z
    .object({
      include_usage: z.boolean().optional()
    })
    .optional(),
  source_attribution: sourceAttributionSchema.optional()
});
