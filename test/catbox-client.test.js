import test from "node:test";
import assert from "node:assert/strict";
import {
  CatboxClient,
  isCatboxUrl,
  rehostGeneratedImages
} from "../src/catbox/client.js";

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

test("CatboxClient uploads image bytes with fileupload form data", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;

  globalThis.fetch = async (url, options = {}) => {
    request = { url, options };
    return new Response("https://files.catbox.moe/generated-cat.png", {
      status: 200
    });
  };

  try {
    const client = new CatboxClient({
      catboxApiUrl: "https://catbox.moe/user/api.php",
      catboxUserhash: "userhash-123"
    });
    const hostedUrl = await client.uploadFile({
      filename: "Generated Cat.png",
      mimeType: "image/png",
      bytes: Buffer.from("png-bytes")
    });

    assert.equal(hostedUrl, "https://files.catbox.moe/generated-cat.png");
    assert.equal(request.url, "https://catbox.moe/user/api.php");
    assert.equal(request.options.method, "POST");

    const form = request.options.body;
    assert.equal(form.get("reqtype"), "fileupload");
    assert.equal(form.get("userhash"), "userhash-123");

    const file = form.get("fileToUpload");
    assert.equal(file.name, "Generated_Cat.png");
    assert.equal(file.type, "image/png");
    assert.equal(Buffer.from(await file.arrayBuffer()).toString("utf8"), "png-bytes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CatboxClient uploads public urls with urlupload form data", async () => {
  const originalFetch = globalThis.fetch;
  let request = null;

  globalThis.fetch = async (url, options = {}) => {
    request = { url, options };
    return new Response("https://files.catbox.moe/generated-cat.png", {
      status: 200
    });
  };

  try {
    const client = new CatboxClient({
      catboxApiUrl: "https://catbox.moe/user/api.php",
      catboxUserhash: "userhash-123"
    });
    const hostedUrl = await client.uploadUrl({
      url: "https://bridge.example/_catbox/staged/test-token"
    });

    assert.equal(hostedUrl, "https://files.catbox.moe/generated-cat.png");
    assert.equal(request.url, "https://catbox.moe/user/api.php");
    assert.equal(request.options.method, "POST");

    const form = request.options.body;
    assert.equal(form.get("reqtype"), "urlupload");
    assert.equal(form.get("userhash"), "userhash-123");
    assert.equal(
      form.get("url"),
      "https://bridge.example/_catbox/staged/test-token"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CatboxClient surfaces API errors", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response("error: upload rejected", {
      status: 200
    });

  try {
    const client = new CatboxClient();
    await assert.rejects(
      client.uploadFile({
        filename: "broken.png",
        mimeType: "image/png",
        bytes: Buffer.from("png-bytes")
      }),
      /Catbox upload failed: error: upload rejected/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CatboxClient verifyFile accepts non-empty ranged responses", async () => {
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
    const client = new CatboxClient();
    const result = await client.verifyFile("https://files.catbox.moe/test.jpg");
    assert.equal(result, "https://files.catbox.moe/test.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CatboxClient verifyFile rejects empty uploads", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(Buffer.alloc(0), {
      status: 200,
      headers: {
        "content-type": "image/jpeg"
      }
    });

  try {
    const client = new CatboxClient();
    await assert.rejects(
      client.verifyFile("https://files.catbox.moe/test.jpg"),
      /Catbox upload verification failed: uploaded file is empty/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CatboxClient retries empty responses from Catbox", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;

  globalThis.fetch = async () => {
    attempts += 1;
    return new Response(
      attempts === 1 ? "" : "https://files.catbox.moe/retried-image.jpg",
      {
        status: 200
      }
    );
  };

  try {
    const client = new CatboxClient();
    const hostedUrl = await client.uploadFile({
      filename: "retry.jpg",
      mimeType: "image/jpeg",
      bytes: Buffer.from("jpeg-bytes")
    });

    assert.equal(attempts, 2);
    assert.equal(hostedUrl, "https://files.catbox.moe/retried-image.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rehostGeneratedImages uploads protected Grok assets to Catbox in parallel while preserving order", async () => {
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
        return `https://files.catbox.moe/${bytes.toString("utf8")}.png`;
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
      "https://files.catbox.moe/first-image.png",
      "https://files.catbox.moe/second-image.png"
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

test("rehostGeneratedImages skips Catbox URLs", async () => {
  let loadCount = 0;
  const images = [
    {
      title: "already hosted",
      mimeType: "image/png",
      url: "https://files.catbox.moe/already-hosted.png"
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
  assert.equal(isCatboxUrl(hostedImages[0].url), true);
});
