import test from "node:test";
import assert from "node:assert/strict";
import { createResponseEnvelope } from "../src/openai/response-object.js";

test("createResponseEnvelope defaults image outputs to result_url without inline bytes", () => {
  const response = createResponseEnvelope({
    id: "resp_123",
    messageId: "msg_123",
    model: "grok-4-auto",
    text: "Done.",
    images: [
      {
        id: "ig_image_123",
        result: "YmFzZTY0",
        url: "https://assets.grok.com/generated/cat.jpg",
        mimeType: "image/jpeg",
        prompt: "generate an image of a cat",
        revisedPrompt: "a refined cat prompt",
        action: "generate",
        imageModel: "imagine_x_1",
        title: "Generated Image"
      }
    ]
  });

  assert.equal(response.output[0].type, "message");
  assert.equal(response.output[1].type, "image_generation_call");
  assert.equal("result" in response.output[1], false);
  assert.equal(
    response.output[1].result_url,
    "https://assets.grok.com/generated/cat.jpg"
  );
  assert.equal(response.output[1].output_format, "jpeg");
});
