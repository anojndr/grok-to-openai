import test from "node:test";
import assert from "node:assert/strict";
import {
  ImgbbClient,
  isImgbbUrl,
  rehostGeneratedImages
} from "../src/imgbb/client.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject
  };
}

function flushAsyncOperations() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("ImgbbClient uploads image bytes with multipart form data", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;

  globalThis.fetch = async (url, options = {}) => {
    request = { url, options };
    return new Response(
      JSON.stringify({
        data: {
          url: "https://i.ibb.co/demo/generated-cat.png"
        },
        success: true,
        status: 200
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };

  try {
    const client = new ImgbbClient({
      imgbbApiUrl: "https://api.imgbb.com/1/upload",
      imgbbApiKey: "api-key-123"
    });
    const hostedUrl = await client.uploadFile({
      filename: "Generated Cat.png",
      mimeType: "image/png",
      bytes: Buffer.from("png-bytes")
    });

    assert.equal(hostedUrl, "https://i.ibb.co/demo/generated-cat.png");

    const requestUrl = new URL(request.url);
    assert.equal(`${requestUrl.origin}${requestUrl.pathname}`, "https://api.imgbb.com/1/upload");
    assert.equal(requestUrl.searchParams.get("key"), "api-key-123");
    assert.equal(request.options.method, "POST");

    const form = request.options.body;
    const file = form.get("image");
    assert.equal(file.name, "Generated_Cat.png");
    assert.equal(file.type, "image/png");
    assert.equal(form.get("name"), "Generated_Cat");
    assert.equal(Buffer.from(await file.arrayBuffer()).toString("utf8"), "png-bytes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ImgbbClient includes expiration when configured", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;

  globalThis.fetch = async (url, options = {}) => {
    request = { url, options };
    return new Response(
      JSON.stringify({
        data: {
          url: "https://i.ibb.co/demo/with-expiration.png"
        },
        success: true,
        status: 200
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };

  try {
    const client = new ImgbbClient({
      imgbbApiKey: "api-key-123",
      imgbbExpiration: "600"
    });
    const hostedUrl = await client.uploadFile({
      filename: "expiring.png",
      mimeType: "image/png",
      bytes: Buffer.from("png-bytes")
    });

    assert.equal(hostedUrl, "https://i.ibb.co/demo/with-expiration.png");

    const requestUrl = new URL(request.url);
    assert.equal(requestUrl.searchParams.get("key"), "api-key-123");
    assert.equal(requestUrl.searchParams.get("expiration"), "600");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ImgbbClient requires an API key", async () => {
  const client = new ImgbbClient();

  await assert.rejects(
    client.uploadFile({
      filename: "missing-key.png",
      mimeType: "image/png",
      bytes: Buffer.from("png-bytes")
    }),
    /Imgbb upload is not configured: IMGBB_API_KEY is missing/
  );
});

test("ImgbbClient surfaces API errors", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        error: {
          message: "Invalid API key"
        }
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json"
        }
      }
    );

  try {
    const client = new ImgbbClient({
      imgbbApiKey: "bad-key"
    });
    await assert.rejects(
      client.uploadFile({
        filename: "broken.png",
        mimeType: "image/png",
        bytes: Buffer.from("png-bytes")
      }),
      /Imgbb upload failed: Invalid API key/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ImgbbClient verifyFile accepts non-empty ranged responses", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_url, options = {}) => {
    assert.equal(options.headers.Range, "bytes=0-0");
    return new Response(Buffer.from([0xff]), {
      status: 206,
      headers: {
        "content-type": "image/jpeg",
        "content-range": "bytes 0-0/12345"
      }
    });
  };

  try {
    const client = new ImgbbClient();
    const result = await client.verifyFile("https://i.ibb.co/demo/test.jpg");
    assert.equal(result, "https://i.ibb.co/demo/test.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ImgbbClient verifyFile rejects empty uploads", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(Buffer.alloc(0), {
      status: 200,
      headers: {
        "content-type": "image/jpeg"
      }
    });

  try {
    const client = new ImgbbClient();
    await assert.rejects(
      client.verifyFile("https://i.ibb.co/demo/test.jpg"),
      /Imgbb upload verification failed: uploaded file is empty/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ImgbbClient retries empty responses from Imgbb", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async () => {
    attempts += 1;

    return new Response(
      attempts === 1
        ? ""
        : JSON.stringify({
            data: {
              url: "https://i.ibb.co/demo/retried-image.jpg"
            },
            success: true,
            status: 200
          }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  };

  try {
    const client = new ImgbbClient({
      imgbbApiKey: "api-key-123"
    });
    const hostedUrl = await client.uploadFile({
      filename: "retry.jpg",
      mimeType: "image/jpeg",
      bytes: Buffer.from("jpeg-bytes")
    });

    assert.equal(attempts, 2);
    assert.equal(hostedUrl, "https://i.ibb.co/demo/retried-image.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ImgbbClient rejects uploads larger than 32 MB", async () => {
  const client = new ImgbbClient({
    imgbbApiKey: "api-key-123"
  });

  await assert.rejects(
    client.uploadFile({
      filename: "too-large.png",
      mimeType: "image/png",
      bytes: Buffer.alloc((32 * 1024 * 1024) + 1)
    }),
    /Imgbb upload failed: image exceeds 32 MB limit/
  );
});

test("ImgbbClient rejects invalid expiration config", async () => {
  assert.throws(
    () =>
      new ImgbbClient({
        imgbbApiKey: "api-key-123",
        imgbbExpiration: "30"
      }),
    /Imgbb upload is not configured: IMGBB_EXPIRATION must be between 60 and 15552000 seconds/
  );
});

test("rehostGeneratedImages uploads protected Grok assets to Imgbb in parallel while preserving order", async () => {
  const firstAsset = createDeferred();
  const secondAsset = createDeferred();
  const loadCalls = [];
  const uploadCalls = [];

  const rehostPromise = rehostGeneratedImages({
    images: [
      {
        title: "first preview",
        mimeType: "image/png",
        url: "https://assets.grok.com/generated/first-preview.png"
      },
      {
        title: "second preview",
        mimeType: "image/png",
        url: "https://assets.grok.com/generated/second-preview.png"
      }
    ],
    loadSourceImage: async (image) => {
      loadCalls.push(image.title);
      return image.title === "first preview"
        ? firstAsset.promise
        : secondAsset.promise;
    },
    uploadClient: {
      async uploadFile({ filename, bytes }) {
        uploadCalls.push(filename);
        return `https://i.ibb.co/demo/${bytes.toString("utf8")}.png`;
      }
    }
  });

  await flushAsyncOperations();
  assert.deepEqual(loadCalls, ["first preview", "second preview"]);

  secondAsset.resolve({
    bytes: Buffer.from("second-image"),
    contentType: "image/png"
  });
  firstAsset.resolve({
    bytes: Buffer.from("first-image"),
    contentType: "image/png"
  });

  const hostedImages = await rehostPromise;
  assert.deepEqual(uploadCalls, ["second-preview.png", "first-preview.png"]);
  assert.deepEqual(
    hostedImages.map((image) => image.url),
    [
      "https://i.ibb.co/demo/first-image.png",
      "https://i.ibb.co/demo/second-image.png"
    ]
  );
  assert.deepEqual(
    hostedImages.map((image) => image.bytes.toString("utf8")),
    ["first-image", "second-image"]
  );
  assert.deepEqual(
    hostedImages.map((image) => image.sourceUrl),
    [
      "https://assets.grok.com/generated/first-preview.png",
      "https://assets.grok.com/generated/second-preview.png"
    ]
  );
});

test("rehostGeneratedImages skips Imgbb URLs", async () => {
  let loadCount = 0;
  const images = [
    {
      title: "already hosted",
      mimeType: "image/png",
      url: "https://i.ibb.co/demo/already-hosted.png"
    }
  ];

  const hostedImages = await rehostGeneratedImages({
    images,
    loadSourceImage: async () => {
      loadCount += 1;
      return null;
    },
    uploadClient: {
      async uploadFile() {
        throw new Error("uploadFile should not be called");
      }
    }
  });

  assert.equal(loadCount, 0);
  assert.deepEqual(hostedImages, images);
  assert.equal(isImgbbUrl(hostedImages[0].url), true);
});

test("rehostGeneratedImages skips public non-Grok image URLs", async () => {
  let loadCount = 0;
  const images = [
    {
      title: "Example Source image",
      mimeType: "image/jpeg",
      url: "https://images.example.com/face.jpg",
      action: "search",
      sourceUrlType: "external"
    }
  ];

  const hostedImages = await rehostGeneratedImages({
    images,
    loadSourceImage: async () => {
      loadCount += 1;
      return null;
    },
    uploadClient: {
      async uploadFile() {
        throw new Error("uploadFile should not be called");
      }
    }
  });

  assert.equal(loadCount, 0);
  assert.deepEqual(hostedImages, images);
});
