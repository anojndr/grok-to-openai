import { z } from "zod";

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
  image_url: z.string().optional()
});

const messageContentPart = z.union([inputTextPart, inputFilePart, inputImagePart]);

const messageInput = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: z.union([z.string(), z.array(messageContentPart)])
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
  conversation: z.string().optional()
});
