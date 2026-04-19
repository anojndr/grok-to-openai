const GROK_RENDER_REGEX = /<grok:render\b([^>]*)>([\s\S]*?)<\/grok:render>/g;
const ARGUMENT_REGEX = /<argument name="([^"]+)">([\s\S]*?)<\/argument>/g;

function readAttribute(attributes, name) {
  const match = new RegExp(`\\b${name}="([^"]+)"`).exec(attributes || "");
  return match?.[1] ?? null;
}

function parseCardAttachment(rawCard) {
  if (!rawCard) {
    return null;
  }

  if (typeof rawCard === "object") {
    return rawCard;
  }

  try {
    return JSON.parse(rawCard);
  } catch {
    return null;
  }
}

function parseRenderCards(text = "") {
  const renderCards = new Map();
  let renderIndex = 0;

  for (const match of text.matchAll(GROK_RENDER_REGEX)) {
    const attributes = match[1] ?? "";
    const inner = match[2] ?? "";
    const cardId = readAttribute(attributes, "card_id");
    if (!cardId) {
      continue;
    }

    const args = {};
    for (const argument of inner.matchAll(ARGUMENT_REGEX)) {
      args[argument[1]] = argument[2];
    }

    renderCards.set(cardId, {
      cardId,
      cardType: readAttribute(attributes, "card_type"),
      renderType: readAttribute(attributes, "type"),
      args,
      renderIndex
    });
    renderIndex += 1;
  }

  return renderCards;
}

function resolveImageAction(value) {
  const candidate = (value || "").toLowerCase();

  if (candidate.includes("edited")) {
    return "edit";
  }

  if (candidate.includes("generated")) {
    return "generate";
  }

  return null;
}

function inferMimeType(url) {
  let normalized = "";

  try {
    normalized = new URL(url).pathname.toLowerCase();
  } catch {
    normalized = (url || "").toLowerCase();
  }

  if (normalized.endsWith(".png")) {
    return "image/png";
  }

  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }

  if (normalized.endsWith(".gif")) {
    return "image/gif";
  }

  return "application/octet-stream";
}

function isFinalImageUrl(url) {
  return !/-part-\d+\//.test(url || "");
}

function preferCandidate(current, next) {
  if (!current) {
    return next;
  }

  const currentIsFinal = isFinalImageUrl(current.url);
  const nextIsFinal = isFinalImageUrl(next.url);
  if (currentIsFinal !== nextIsFinal) {
    return nextIsFinal ? next : current;
  }

  const currentProgress = current.progress ?? 0;
  const nextProgress = next.progress ?? 0;
  if (currentProgress !== nextProgress) {
    return nextProgress > currentProgress ? next : current;
  }

  const currentSeq = current.seq ?? 0;
  const nextSeq = next.seq ?? 0;
  if (currentSeq !== nextSeq) {
    return nextSeq > currentSeq ? next : current;
  }

  return current;
}

export function resolveGrokAssetUrl(assetPath, grokBaseUrl = "https://grok.com") {
  if (!assetPath) {
    return null;
  }

  try {
    return new URL(assetPath).toString();
  } catch {
    const baseUrl = new URL(grokBaseUrl);
    const assetOrigin = baseUrl.hostname.endsWith("grok.com")
      ? `${baseUrl.protocol}//assets.grok.com/`
      : `${baseUrl.origin}/`;

    return new URL(assetPath.replace(/^\/+/, ""), assetOrigin).toString();
  }
}

function buildGeneratedImageCandidate({
  chunk,
  card,
  renderCard,
  modelResponse,
  grokBaseUrl,
  action
}) {
  const key = chunk.imageUuid || `${card?.id || "image"}:${chunk.imageIndex ?? 0}`;

  return {
    key,
    id: chunk.imageUuid ? `ig_${chunk.imageUuid}` : `ig_${key.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    responseId: modelResponse?.responseId ?? null,
    cardId: card?.id ?? renderCard?.cardId ?? null,
    action,
    title:
      chunk.imageTitle ?? (action === "edit" ? "Edited Image" : "Generated Image"),
    prompt:
      renderCard?.args?.prompt ??
      chunk.imagePrompt?.prompt ??
      card?.prompt ??
      null,
    revisedPrompt: chunk.imagePrompt?.upsampledPrompt ?? null,
    url: resolveGrokAssetUrl(chunk.imageUrl, grokBaseUrl),
    mimeType: inferMimeType(chunk.imageUrl),
    imageModel: chunk.imageModel ?? chunk.imagePrompt?.modelName ?? null,
    imageIndex: chunk.imageIndex ?? renderCard?.renderIndex ?? 0,
    progress: chunk.progress ?? null,
    seq: chunk.seq ?? null,
    orientation: renderCard?.args?.orientation ?? card?.orientation ?? null,
    sourceImageId: renderCard?.args?.image_id ?? null,
    sourceUrlType: "grok_asset"
  };
}

function resolveSearchImageLabel(card) {
  const sourceName = typeof card?.image?.source === "string" ? card.image.source.trim() : "";
  if (sourceName) {
    return `${sourceName} image`;
  }

  return "Search result image";
}

function buildSearchImageCandidate({
  card,
  renderCard,
  modelResponse
}) {
  const image = card?.image ?? null;
  const url = image?.original || image?.thumbnail || null;
  if (!url) {
    return null;
  }

  const key =
    image?.image_id ||
    `${card?.id || "search"}:${renderCard?.renderIndex ?? 0}`;

  return {
    key,
    id: `img_${String(key).replace(/[^a-zA-Z0-9_]/g, "_")}`,
    responseId: modelResponse?.responseId ?? null,
    cardId: card?.id ?? renderCard?.cardId ?? null,
    action: "search",
    title: resolveSearchImageLabel(card),
    prompt: null,
    revisedPrompt: null,
    url,
    mimeType: inferMimeType(url),
    imageModel: null,
    imageIndex: renderCard?.renderIndex ?? 0,
    progress: 100,
    seq: null,
    orientation: null,
    sourceImageId: null,
    sourceName: image?.source ?? null,
    sourceTitle: image?.title ?? null,
    sourcePageUrl: image?.link ?? null,
    thumbnailUrl: image?.thumbnail ?? null,
    imageId: image?.image_id ?? null,
    sourceUrlType: "external"
  };
}

export function extractAssistantImages({
  assistantText = "",
  modelResponse = null,
  grokBaseUrl = "https://grok.com"
}) {
  const messageText = modelResponse?.message || assistantText || "";
  const renderCards = parseRenderCards(messageText);
  const imagesByKey = new Map();

  function registerCandidate(key, candidate) {
    const preferred = preferCandidate(imagesByKey.get(key), candidate);
    imagesByKey.set(key, preferred);
  }

  for (const rawCard of modelResponse?.cardAttachmentsJson ?? []) {
    const card = parseCardAttachment(rawCard);
    const chunk = card?.image_chunk ?? null;
    const renderCard = card?.id ? renderCards.get(card.id) : null;
    const action =
      resolveImageAction(card?.type) ||
      resolveImageAction(renderCard?.renderType) ||
      resolveImageAction(card?.cardType) ||
      resolveImageAction(renderCard?.cardType);

    if (chunk?.imageUrl && action) {
      const candidate = buildGeneratedImageCandidate({
        chunk,
        card,
        renderCard,
        modelResponse,
        grokBaseUrl,
        action
      });
      registerCandidate(candidate.key, candidate);
      continue;
    }

    const isSearchImage =
      card?.type === "render_searched_image" ||
      renderCard?.renderType === "render_searched_image";
    if (!isSearchImage) {
      continue;
    }

    const candidate = buildSearchImageCandidate({
      card,
      renderCard,
      modelResponse
    });
    if (!candidate) {
      continue;
    }

    registerCandidate(candidate.key, candidate);
  }

  for (const [index, assetPath] of (modelResponse?.generatedImageUrls ?? []).entries()) {
    const key = `generated:${index}`;
    registerCandidate(key, {
      id: `ig_generated_${index}`,
      responseId: modelResponse?.responseId ?? null,
      cardId: null,
      action: "generate",
      title: "Generated Image",
      prompt: null,
      revisedPrompt: null,
      url: resolveGrokAssetUrl(assetPath, grokBaseUrl),
      mimeType: inferMimeType(assetPath),
      imageModel: null,
      imageIndex: index,
      progress: 100,
      seq: null,
      orientation: null,
      sourceImageId: null,
      sourceUrlType: "grok_asset"
    });
  }

  return [...imagesByKey.values()]
    .sort((left, right) => {
      if ((left.imageIndex ?? 0) !== (right.imageIndex ?? 0)) {
        return (left.imageIndex ?? 0) - (right.imageIndex ?? 0);
      }

      return left.id.localeCompare(right.id);
    })
    .map(({ key: _key, ...image }) => image);
}

export function extractGeneratedImages(options) {
  return extractAssistantImages(options).filter(
    (image) => image.action === "generate" || image.action === "edit"
  );
}
