const TOOL_USAGE_CARD_REGEX = /<xai:tool_usage_card>[\s\S]*?<\/xai:tool_usage_card>/g;
const GROK_RENDER_REGEX = /<grok:render\b([^>]*)>[\s\S]*?<\/grok:render>/g;
const TOOL_USAGE_WEB_SEARCH_REGEX =
  /<xai:tool_usage_card>[\s\S]*?<xai:tool_usage_card_id>([^<]+)<\/xai:tool_usage_card_id>[\s\S]*?<xai:tool_name>web_search<\/xai:tool_name>[\s\S]*?<xai:tool_args><!\[CDATA\[([\s\S]*?)\]\]><\/xai:tool_args>[\s\S]*?<\/xai:tool_usage_card>/g;
const CITATION_PLACEHOLDER_REGEX = /\uE000([^\uE001]+)\uE001/g;
const CITATION_GROUP_REGEX = /(?:\uE000[^\uE001]+\uE001\s*)+/g;

function cleanText(text) {
  let output = text ?? "";
  output = output.replace(/[ \t]+\n/g, "\n");
  output = output.replace(/\n{3,}/g, "\n\n");
  return output.trim();
}

function stripToolUsageCards(text) {
  return (text ?? "").replace(TOOL_USAGE_CARD_REGEX, "");
}

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

function normalizeWebSearchResults(results) {
  return (results ?? [])
    .filter((result) => result?.url)
    .map((result) => ({
      url: result.url,
      title: result.title ?? null,
      preview: result.preview ?? null
    }));
}

function shortenUrl(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);

    if (!segments.length) {
      return hostname;
    }

    const abbreviatedPath = segments.slice(0, 2).join("/");
    const suffix = segments.length > 2 ? "/..." : "";
    const candidate = `${hostname}/${abbreviatedPath}${suffix}`;

    if (candidate.length <= 48) {
      return candidate;
    }

    return `${hostname}/${segments[0]}/...`;
  } catch {
    return urlString;
  }
}

function extractCitationCards(modelResponse) {
  const cards = [];
  const seen = new Set();

  for (const rawCard of modelResponse?.cardAttachmentsJson ?? []) {
    const card = parseCardAttachment(rawCard);
    if (!card?.id || !card?.url || seen.has(card.id)) {
      continue;
    }

    seen.add(card.id);
    cards.push({
      id: card.id,
      url: card.url,
      cardType: card.cardType ?? null,
      type: card.type ?? null,
      shortUrl: shortenUrl(card.url)
    });
  }

  return cards;
}

function extractSearchQuerySessionsFromSteps(modelResponse) {
  const sessions = [];
  const seen = new Set();

  for (const step of modelResponse?.steps ?? []) {
    const resultsByCardId = new Map(
      (step.toolUsageResults ?? []).map((entry) => [entry.toolUsageCardId, entry])
    );

    for (const toolUsageCard of step.toolUsageCards ?? []) {
      const query = toolUsageCard?.webSearch?.args?.query;
      const toolUsageCardId = toolUsageCard?.toolUsageCardId ?? null;
      const dedupeKey = toolUsageCardId || query;

      if (!query || !dedupeKey || seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      const results =
        resultsByCardId.get(toolUsageCardId)?.webSearchResults?.results ?? [];

      sessions.push({
        toolUsageCardId,
        query,
        results: normalizeWebSearchResults(results)
      });
    }
  }

  return sessions;
}

function extractSearchQuerySessionsFromMarkup(text) {
  const sessions = [];
  const seen = new Set();

  for (const match of text.matchAll(TOOL_USAGE_WEB_SEARCH_REGEX)) {
    const toolUsageCardId = match[1]?.trim() || null;
    const rawArgs = match[2] ?? "";

    try {
      const args = JSON.parse(rawArgs);
      const query = args?.query;
      const dedupeKey = toolUsageCardId || query;

      if (!query || !dedupeKey || seen.has(dedupeKey)) {
        continue;
      }

      seen.add(dedupeKey);
      sessions.push({
        toolUsageCardId,
        query,
        results: []
      });
    } catch {
      continue;
    }
  }

  return sessions;
}

function buildSourceEntries({
  modelResponse,
  citationCards,
  searchQuerySessions
}) {
  const sources = [];
  const sourcesByUrl = new Map();
  const citedUrlSet = new Set(citationCards.map((card) => card.url));

  function getOrCreateSource(candidate) {
    if (!candidate?.url) {
      return null;
    }

    if (!sourcesByUrl.has(candidate.url)) {
      const source = {
        url: candidate.url,
        shortUrl: shortenUrl(candidate.url),
        title: candidate.title ?? null,
        preview: candidate.preview ?? null,
        cited: false,
        citationCardIds: [],
        searchQueries: []
      };
      sourcesByUrl.set(candidate.url, source);
      sources.push(source);
    }

    const source = sourcesByUrl.get(candidate.url);
    if (!source.title && candidate.title) {
      source.title = candidate.title;
    }
    if (!source.preview && candidate.preview) {
      source.preview = candidate.preview;
    }

    return source;
  }

  for (const result of normalizeWebSearchResults(modelResponse?.webSearchResults)) {
    getOrCreateSource(result);
  }

  for (const citation of citationCards) {
    const source = getOrCreateSource(citation);
    if (!source) {
      continue;
    }

    source.cited = true;
    if (!source.citationCardIds.includes(citation.id)) {
      source.citationCardIds.push(citation.id);
    }
  }

  for (const session of searchQuerySessions) {
    for (const result of session.results) {
      const source = getOrCreateSource(result);
      if (!source || !session.query || source.searchQueries.includes(session.query)) {
        continue;
      }

      source.searchQueries.push(session.query);
    }
  }

  for (const source of sources) {
    if (citedUrlSet.has(source.url)) {
      source.cited = true;
    }
  }

  return sources;
}

function createCitationPlaceholder(cardId) {
  return `\uE000${cardId}\uE001`;
}

function renderCitationGroup(group, citationByCardId) {
  const links = [];
  const seen = new Set();
  const trailingWhitespace = /\s+$/.exec(group)?.[0] ?? "";

  for (const match of group.matchAll(CITATION_PLACEHOLDER_REGEX)) {
    const cardId = match[1];
    const citation = citationByCardId.get(cardId);
    const dedupeKey = citation?.url || cardId;
    if (!citation || seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    links.push(`[${citation.shortUrl}](${citation.url})`);
  }

  if (!links.length) {
    return "";
  }

  return ` (${links.join(", ")})${trailingWhitespace}`;
}

function renderInlineCitations(text, citationByCardId) {
  const withPlaceholders = text.replace(GROK_RENDER_REGEX, (_match, attributes) => {
    const renderType = readAttribute(attributes, "type");
    const cardId = readAttribute(attributes, "card_id");

    if (renderType !== "render_inline_citation" || !cardId) {
      return "";
    }

    return createCitationPlaceholder(cardId);
  });

  return withPlaceholders.replace(
    CITATION_GROUP_REGEX,
    (group) => renderCitationGroup(group, citationByCardId)
  );
}

function stripRenderTags(text) {
  return text.replace(GROK_RENDER_REGEX, "");
}

function formatSourceEntry(source, options) {
  const label = source.title || source.shortUrl;
  const shortUrlNote =
    source.title && source.title !== source.shortUrl ? ` (${source.shortUrl})` : "";
  const citedNote = source.cited ? " [cited]" : "";
  const queryNote =
    options.includeSearchQueries && source.searchQueries.length
      ? ` via ${source.searchQueries.map((query) => `\`${query}\``).join("; ")}`
      : "";

  return `[${label}](${source.url})${shortUrlNote}${citedNote}${queryNote}`;
}

function renderSourceAppendix(sourceAttribution, options) {
  if (!options.includeSources || !sourceAttribution.sources.length) {
    return "";
  }

  const lines = ["Sources"];

  sourceAttribution.sources.forEach((source, index) => {
    lines.push(`${index + 1}. ${formatSourceEntry(source, options)}`);
  });

  if (options.includeSearchQueries && sourceAttribution.searchQueries.length) {
    lines.push("");
    lines.push("Search Queries");
    sourceAttribution.searchQueries.forEach((query, index) => {
      lines.push(`${index + 1}. \`${query}\``);
    });
  }

  return lines.join("\n");
}

export function resolveSourceAttributionOptions(options = {}) {
  return {
    inlineCitations: options?.inline_citations !== false,
    includeSources:
      options?.include_sources === true || options?.include_search_queries === true,
    includeSearchQueries: options?.include_search_queries === true
  };
}

export function extractSourceAttribution({
  assistantText = "",
  modelResponse = null
}) {
  const citationCards = extractCitationCards(modelResponse);
  const searchQuerySessions = extractSearchQuerySessionsFromSteps(modelResponse);

  if (!searchQuerySessions.length) {
    searchQuerySessions.push(...extractSearchQuerySessionsFromMarkup(assistantText));
  }

  const sources = buildSourceEntries({
    modelResponse,
    citationCards,
    searchQuerySessions
  });

  return {
    citations: citationCards,
    sources,
    searchQueries: [...new Set(searchQuerySessions.map((session) => session.query))]
  };
}

export function createSourceAttributionPayload({
  sourceAttribution,
  options
}) {
  if (
    !sourceAttribution ||
    (!sourceAttribution.citations.length &&
      !sourceAttribution.sources.length &&
      !sourceAttribution.searchQueries.length)
  ) {
    return null;
  }

  return {
    inline_citations: options.inlineCitations ? "short_url_markdown" : "none",
    citation_count: sourceAttribution.citations.length,
    cited_source_count: sourceAttribution.sources.filter((source) => source.cited).length,
    source_count: sourceAttribution.sources.length,
    search_query_count: sourceAttribution.searchQueries.length,
    citations: sourceAttribution.citations.map((citation) => ({
      card_id: citation.id,
      url: citation.url,
      short_url: citation.shortUrl
    })),
    sources: options.includeSources
      ? sourceAttribution.sources.map((source) => ({
          url: source.url,
          short_url: source.shortUrl,
          title: source.title,
          preview: source.preview,
          cited: source.cited,
          citation_card_ids: source.citationCardIds,
          search_queries: options.includeSearchQueries ? source.searchQueries : []
        }))
      : [],
    search_queries: options.includeSearchQueries ? sourceAttribution.searchQueries : []
  };
}

export function renderGrokText({
  text = "",
  sourceAttribution = { citations: [], sources: [], searchQueries: [] },
  options = resolveSourceAttributionOptions()
}) {
  const citationByCardId = new Map(
    sourceAttribution.citations.map((citation) => [citation.id, citation])
  );

  let output = stripToolUsageCards(text);
  output = options.inlineCitations
    ? renderInlineCitations(output, citationByCardId)
    : stripRenderTags(output);
  output = cleanText(output);

  const appendix = renderSourceAppendix(sourceAttribution, options);
  if (!appendix) {
    return output;
  }

  return output ? `${output}\n\n${appendix}` : appendix;
}
