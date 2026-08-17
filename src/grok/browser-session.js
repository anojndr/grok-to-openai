import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { HttpError } from "../lib/errors.js";
import { readCookiesFromSource } from "../lib/cookies.js";

export const ERROR_RESPONSE_TEXT_LIMIT = 128 * 1024;
export const GROK_SESSION_BLOCKED_ERROR_CODE = "grok_session_blocked";
export const GROK_REQUEST_TIMEOUT_ERROR_CODE = "grok_request_timeout";

// Error markers produced by the in-page bridge when statsig id generation
// fails. The chunk-stale marker means the cached middleware chunk/module is
// outdated and must be rediscovered; the generic marker means the page never
// became ready to generate an id. The bridge MUST NOT send requests with a
// placeholder statsig id: xAI rejects them with
// "Request rejected by anti-bot rules." (HTTP 403 / in-stream error).
export const STATSIG_CHUNK_STALE_MARKER = "__grokBridgeStatsigChunkStale";
export const STATSIG_GENERATION_FAILED_MARKER = "__grokBridgeStatsigFailed";

function clearTextBuffer(buffer) {
  buffer.chunks.length = 0;
  buffer.length = 0;
}

function setTextBufferLimit(buffer, limit) {
  buffer.limit = limit;

  if (limit === 0) {
    clearTextBuffer(buffer);
    return;
  }

  if (Number.isFinite(limit) && buffer.length > limit) {
    const trimmed = buffer.chunks.join("").slice(0, limit);
    buffer.chunks.length = 0;
    if (trimmed) {
      buffer.chunks.push(trimmed);
    }
    buffer.length = trimmed.length;
  }
}

function appendTextChunk(buffer, chunk) {
  if (!chunk || buffer.limit === 0) {
    return;
  }

  if (!Number.isFinite(buffer.limit)) {
    buffer.chunks.push(chunk);
    buffer.length += chunk.length;
    return;
  }

  const remaining = buffer.limit - buffer.length;
  if (remaining <= 0) {
    return;
  }

  const nextChunk = chunk.slice(0, remaining);
  if (!nextChunk) {
    return;
  }

  buffer.chunks.push(nextChunk);
  buffer.length += nextChunk.length;
}

export function installGrokBridgePageHelpers() {
  if (typeof window.__grokBridgeFetch === "function") {
    window.grokBridgeFetch = window.__grokBridgeFetch;
    window.grokBridgeAbortRequest = window.__grokBridgeAbortRequest;
    return;
  }

  const requestControllers = new Map();
  window.__grokBridgeAbortRequest = (requestId) => {
    const controller = requestControllers.get(requestId);
    if (!controller) {
      return false;
    }

    controller.abort();
    return true;
  };
  window.grokBridgeAbortRequest = window.__grokBridgeAbortRequest;

  // Element caching to survive anti-bot DOM removal
  const savedElements = [];
  const cachedElementClones = new WeakMap();
  const oversizedElements = new WeakSet();
  const savedElementBuckets = new Map();
  const selectorMatchCache = new Map();
  const classMatchCache = new Map();
  const maxCachedElementDescendants = 128;
  const maxCachedPathAncestorDepth = 12;
  // The clone cache exists to survive anti-bot DOM teardown, but every
  // unique SVG/meta node the observer sees used to be cloned and retained
  // forever: on a long-lived page the detached clones and their buckets
  // grew without bound. Keep a bounded FIFO window of recent clones — the
  // botox stand-ins are re-created and re-cached on demand, so eviction
  // never breaks statsig id generation.
  const maxSavedElements = 1024;
  const maxSavedElementBuckets = 512;
  let savedElementsVersion = 0;

  // The statsig middleware queries the "loading X" logo by its obfuscated
  // class name, which changes with every Grok deploy. Keep every class name
  // we have ever seen (legacy fallback, __next_f payloads, and real logo
  // elements) and stamp them all onto the botox stand-ins so the middleware
  // finds its element no matter which variant the current build queries.
  // `r-gtuf8w` is the class the middleware queried in the build that dropped
  // css_class from __next_f; it is also learned dynamically from the
  // middleware's own queries (see learnStatsigClassesFromSelector), so the
  // seed only shortens the first request after a deploy.
  const knownStatsigCssClasses = new Set(["r-6k45k0", "r-gtuf8w"]);
  const learnStatsigCssClass = (className) => {
    if (typeof className !== "string") {
      return;
    }
    for (const token of className.split(/\s+/)) {
      if (/^r-[a-z0-9]+$/i.test(token)) {
        knownStatsigCssClasses.add(token);
      }
    }
  };

  // The statsig middleware also reads the app's site-verification meta
  // (meta[name^="gr"]) and folds its bytes into the id. Grok injects that
  // meta from JS at boot, so on a page whose app never mounted the meta is
  // missing and generation fails. Remember the first token we ever see and
  // re-inject it when the page lacks one; the token is static per deploy.
  let knownStatsigMetaContent = null;

  // Extract r-* class tokens from a selector the middleware queried. When
  // the middleware asks for a logo class we have never seen (new deploy),
  // this learns it so ensureBotoxElements can stamp it onto the stand-ins
  // before the query is retried. Returns true when new classes were added.
  const learnStatsigClassesFromSelector = (selector) => {
    if (typeof selector !== "string" || !selector.includes("r-")) {
      return false;
    }
    const tokens = selector.match(/\.r-[a-z0-9]+/gi);
    if (!tokens) {
      return false;
    }
    let changed = false;
    for (const token of tokens) {
      const cls = token.slice(1);
      if (/^r-[a-z0-9]+$/i.test(cls) && !knownStatsigCssClasses.has(cls)) {
        knownStatsigCssClasses.add(cls);
        changed = true;
      }
    }
    return changed;
  };

  // Real per-deploy logo curve data + css_class extracted by the server
  // from the /login __next_f payload and sent with every request payload.
  // The middleware folds the curve path values into the statsig id, so the
  // stand-ins must carry the exact deployment values or xAI rejects the id.
  const statsigSeed = { curves: null, cssClass: null };

  const readElementClassName = (element) => {
    if (typeof element.className === "string") {
      return element.className;
    }

    try {
      return element.getAttribute?.("class") || "";
    } catch {
      return "";
    }
  };

  const getElementBucketKey = (element) =>
    [
      element.tagName || "",
      element.id || "",
      readElementClassName(element),
      element.childElementCount ?? ""
    ].join("\u0000");

  const pruneSavedElementsCache = () => {
    // FIFO window: drop the oldest clones, then rebuild the dedupe buckets
    // from what remains so bucket keys never reference evicted clones.
    if (
      savedElements.length <= maxSavedElements &&
      savedElementBuckets.size <= maxSavedElementBuckets
    ) {
      return;
    }

    const excessClones = savedElements.length - maxSavedElements;
    if (excessClones > 0) {
      savedElements.splice(0, excessClones);
    }

    savedElementBuckets.clear();
    for (const savedElement of savedElements) {
      const bucketKey = getElementBucketKey(savedElement);
      const bucket = savedElementBuckets.get(bucketKey);
      if (bucket) {
        bucket.push(savedElement);
      } else if (savedElementBuckets.size < maxSavedElementBuckets) {
        savedElementBuckets.set(bucketKey, [savedElement]);
      }
    }
    savedElementsVersion += 1;
  };

  const cacheElement = (element) => {
    if (!element || element.nodeType !== 1) {
      return false;
    }
    if (oversizedElements.has(element)) {
      return false;
    }

    const mappedClone = cachedElementClones.get(element);
    if (mappedClone) {
      if (savedElements.includes(mappedClone)) {
        return true;
      }
      // The clone was evicted by the FIFO window; re-admit it.
      const bucketKey = getElementBucketKey(element);
      const bucket = savedElementBuckets.get(bucketKey) ?? [];
      bucket.push(mappedClone);
      savedElementBuckets.set(bucketKey, bucket);
      savedElements.push(mappedClone);
      savedElementsVersion += 1;
      pruneSavedElementsCache();
      return true;
    }

    try {
      if (
        element.querySelectorAll("*").length > maxCachedElementDescendants
      ) {
        oversizedElements.add(element);
        return false;
      }

      const bucketKey = getElementBucketKey(element);
      const bucket = savedElementBuckets.get(bucketKey) ?? [];
      const existingClone = bucket.find((savedElement) =>
        savedElement.isEqualNode(element)
      );
      if (existingClone) {
        // A structurally identical clone is already retained; remember the
        // mapping so repeated observations of this element stay cheap.
        cachedElementClones.set(element, existingClone);
        return true;
      }

      const clone = element.cloneNode(true);
      bucket.push(clone);
      savedElementBuckets.set(bucketKey, bucket);
      savedElements.push(clone);
      savedElementsVersion += 1;
      cachedElementClones.set(element, clone);
      pruneSavedElementsCache();
      return true;
    } catch {
      return false;
    }
  };

  const isStatsigCandidate = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    const className = readElementClassName(el);
    const name = el.getAttribute?.("name") || "";
    const id = el.id || "";
    return (
      tag === "PATH" ||
      tag === "SVG" ||
      tag === "META" ||
      className.includes("r-6k") ||
      id.startsWith("loading-x-anim-") ||
      name.startsWith("gr")
    );
  };

  const handleNode = (node) => {
    if (!node || node.nodeType !== 1) {
      return;
    }

    if (isStatsigCandidate(node)) {
      cacheElement(node);
    }

    const candidates = [];
    try {
      if (node.matches?.("path, svg, meta[name^=gr], [class*=\"r-6k\"], [id^=\"loading-x-anim-\"]")) {
        candidates.push(node);
      }
      candidates.push(
        ...node.querySelectorAll("path, svg, meta[name^=gr], [class*=\"r-6k\"], [id^=\"loading-x-anim-\"]")
      );
    } catch {
      return;
    }

    for (const targetElement of candidates) {
      learnStatsigCssClass(readElementClassName(targetElement));
      if (
        targetElement.tagName === "META" &&
        typeof targetElement.getAttribute === "function"
      ) {
        const metaName = targetElement.getAttribute("name") || "";
        if (metaName.startsWith("gr")) {
          const metaContent = targetElement.getAttribute("content");
          if (metaContent && metaContent !== knownStatsigMetaContent) {
            knownStatsigMetaContent = metaContent;
            // Share the token with the server so other (wedged) pages can
            // re-inject it; the token is static per deploy.
            try {
              window.__grokBridgeCallBinding?.("__grokBridgeStatsigMeta", {
                content: metaContent
              });
            } catch {}
          }
        }
      }
      cacheElement(targetElement);
      let element = targetElement.parentElement;
      let ancestorDepth = 0;
      while (element && ancestorDepth < maxCachedPathAncestorDepth) {
        if (!cacheElement(element)) {
          break;
        }
        if (element === node) {
          break;
        }
        element = element.parentElement;
        ancestorDepth += 1;
      }
    }
  };

  // Initial scan in case document is already partially parsed
  try {
    if (document.documentElement) {
      handleNode(document.documentElement);
    }
  } catch {}

  // Observe DOM additions dynamically (including attributes)
  try {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes) {
          for (const node of mutation.addedNodes) {
            handleNode(node);
          }
        }
        if (mutation.type === "attributes" && mutation.target) {
          handleNode(mutation.target);
        }
      }
    });
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "d", "name", "content", "id"]
    });
    if (window.__grokVerbose) {
      console.log("__grokBridge: MutationObserver started.");
    }
  } catch (error) {
    if (window.__grokVerbose) {
      console.error("__grokBridge: Failed to start MutationObserver:", error);
    }
  }

  const getCachedSelectorMatches = (selector) => {
    const cached = selectorMatchCache.get(selector);
    if (cached?.version === savedElementsVersion) {
      return cached.matches;
    }

    const matches = [];
    for (const element of savedElements) {
      try {
        if (element.matches(selector)) {
          matches.push(element);
        }
      } catch {}
    }

    selectorMatchCache.set(selector, {
      version: savedElementsVersion,
      matches
    });
    return matches;
  };

  const getCachedClassMatches = (className) => {
    const cached = classMatchCache.get(className);
    if (cached?.version === savedElementsVersion) {
      return cached.matches;
    }

    const matches = [];
    for (const element of savedElements) {
      try {
        if (element.classList?.contains(className)) {
          matches.push(element);
        }
      } catch {}
    }

    classMatchCache.set(className, {
      version: savedElementsVersion,
      matches
    });
    return matches;
  };

  let isEnsuringBotox = false;
  // 1 when the current stand-ins carry the seeded (real) curve data, 0 when
  // they were built from the synthetic fallback. Forces a rebuild when the
  // server-provided seed curves arrive after a synthetic build.
  let botoxCurvesVersion = 0;
  let originalQuerySelectorAll = null;
  try {
    originalQuerySelectorAll = document.querySelectorAll;
  } catch {}

  const ensureBotoxElements = () => {
    if (isEnsuringBotox) return;
    isEnsuringBotox = true;
    try {
      // The statsig middleware reads meta[name^="gr"] bytes (site
      // verification token) to pick one of the four logo stand-ins. Grok
      // injects that meta from JS at boot; when the page is wedged and the
      // app never mounted, re-inject the last token we captured so
      // generation still succeeds.
      if (knownStatsigMetaContent) {
        let hasGrMeta = false;
        try {
          const metas = document.getElementsByTagName("meta");
          for (let i = 0; i < metas.length; i += 1) {
            if ((metas[i].getAttribute?.("name") || "").startsWith("gr")) {
              hasGrMeta = true;
              break;
            }
          }
        } catch {}
        if (!hasGrMeta) {
          try {
            const metaEl = document.createElement("meta");
            metaEl.setAttribute("name", "grok-site-verification");
            metaEl.setAttribute("content", knownStatsigMetaContent);
            (document.head || document.documentElement || document).appendChild(
              metaEl
            );
          } catch {}
        }
      }

      let container = document.getElementById("__grok_botox_container");
      if (!container) {
        container = document.createElement("div");
        container.id = "__grok_botox_container";
        container.style.cssText =
          "position:absolute;visibility:hidden;top:0;left:0;pointer-events:none;";
        (document.body || document.documentElement || document).appendChild(container);
      }

      const existingSvgs = Array.from(container.querySelectorAll("svg"));
      // Rebuild when any known logo class is missing from the stand-ins:
      // the middleware's class changes per deploy and a stale stand-in
      // set would keep failing its query forever.
      const svgsCarryAllClasses =
        existingSvgs.length >= 4 &&
        existingSvgs.every((el) => {
          const cls = readElementClassName(el);
          for (const known of knownStatsigCssClasses) {
            if (!cls.includes(known)) {
              return false;
            }
          }
          return (
            el.childNodes?.length > 0 &&
            el.childNodes[0]?.childNodes?.length >= 2
          );
        });
      // The curve d stamped on the stand-ins is part of the statsig
      // fingerprint, so when the seed curves arrive (or change) the
      // stand-ins must be rebuilt even if their classes/structure are fine.
      const seedCurvesVersion = statsigSeed.curves ? 1 : 0;
      if (svgsCarryAllClasses && botoxCurvesVersion === seedCurvesVersion) {
        for (const el of existingSvgs) {
          cacheElement(el);
        }
        return;
      }

      let curves = null;
      if (Array.isArray(window.__next_f)) {
        for (const item of window.__next_f) {
          const text =
            typeof item === "string"
              ? item
              : typeof item?.[1] === "string"
              ? item[1]
              : JSON.stringify(item);
          const idx = text.indexOf("\"css_class\"");
          if (idx !== -1) {
            try {
              const startIdx = text.lastIndexOf("{\"curves\":", idx);
              if (startIdx !== -1) {
                const endIdx = text.indexOf("}", idx);
                const jsonStr = text.slice(startIdx, endIdx + 1);
                const parsed = JSON.parse(jsonStr);
                if (Array.isArray(parsed.curves)) {
                  curves = parsed.curves;
                  learnStatsigCssClass(parsed.css_class);
                }
              }
            } catch {}
          }
        }
      }

      if (
        (!Array.isArray(curves) || curves.length === 0) &&
        Array.isArray(statsigSeed.curves) &&
        statsigSeed.curves.length >= 2
      ) {
        // Real deployment curves extracted from the /login payload; these
        // values must match what the middleware (and xAI) expects.
        curves = statsigSeed.curves;
      }

      if (!Array.isArray(curves) || curves.length === 0) {
        // The statsig middleware indexes the parsed curve path segments by
        // `metaBytes[43] % 16`, so each stand-in path must carry at least 16
        // "C" segments or generation crashes on `undefined[0]`. The real
        // loading animation uses long multi-point curves; mirror that shape
        // with a deterministic wave so the fingerprint is non-degenerate.
        const fallbackPoints = Array.from({ length: 17 }, (_, pointIndex) => {
          const phase = (pointIndex % 4) * 2;
          const wave = (offset) => {
            const value = Math.round(Math.sin((pointIndex + offset) / 2) * 9 + 10);
            return Math.max(0, Math.min(23, value));
          };
          return {
            color: [wave(0), wave(1), wave(2), wave(3), wave(4), wave(5)],
            deg: (pointIndex * 17) % 360,
            bezier: [wave(6), wave(7), wave(8), wave(9)]
          };
        });
        curves = [fallbackPoints, fallbackPoints, fallbackPoints, fallbackPoints];
      }

      container.innerHTML = "";
      curves.forEach((curve, index) => {
        const dAttr = `M 10,30 C${curve
          .map(
            (e) =>
              ` ${e.color[0]},${e.color[1]} ${e.color[2]},${e.color[3]} ${e.color[4]},${e.color[5]} h ${e.deg} s ${e.bezier[0]},${e.bezier[1]} ${e.bezier[2]},${e.bezier[3]}`
          )
          .join(" C")}`;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("id", `loading-x-anim-${index}`);
        svg.setAttribute(
          "class",
          `r-1p0dtai r-13gxpu9 r-4qtqp9 r-yyyyoo r-wy61xf r-1d2f490 ${Array.from(
            knownStatsigCssClasses
          ).join(" ")} r-ywje51 r-dnmrzs r-u8s1d r-zchlnj r-1plcrui r-ipm5af r-lrvibr r-1blnp2b`
        );
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path1.setAttribute(
          "d",
          "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
        );
        const path2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path2.setAttribute("d", dAttr);
        path2.setAttribute("fill", "#1d9bf008");
        g.appendChild(path1);
        g.appendChild(path2);
        svg.appendChild(g);
        container.appendChild(svg);
        cacheElement(svg);
      });
      botoxCurvesVersion = seedCurvesVersion;
    } catch {} finally {
      isEnsuringBotox = false;
    }
  };

  // Hook query selectors to return cached elements when they are queried but missing from DOM
  try {
    const rawQuerySelectorAll = document.querySelectorAll;
    originalQuerySelectorAll = rawQuerySelectorAll;
    document.querySelectorAll = function(selector) {
      const result = rawQuerySelectorAll.apply(this, arguments);
      if (selector && typeof selector === "string") {
        if (selector.includes("r-") || selector.startsWith(".")) {
          if (result.length < 4 && !isEnsuringBotox) {
            // Learn a logo class the middleware queries that we have not
            // seen (Grok rotates it per deploy), rebuild the stand-ins with
            // it, then re-query so the middleware finds its element.
            if (learnStatsigClassesFromSelector(selector)) {
              selectorMatchCache.clear?.();
              classMatchCache.clear?.();
            }
            ensureBotoxElements();
            const reResult = rawQuerySelectorAll.apply(this, arguments);
            if (reResult.length >= 4) {
              return reResult;
            }
            if (savedElements.length) {
              const matched = getCachedSelectorMatches(selector);
              if (matched.length) {
                return matched;
              }
            }
          }
        } else if (result.length === 0 && savedElements.length) {
          const matched = getCachedSelectorMatches(selector);
          if (matched.length) {
            return matched;
          }
        }
      }
      return result;
    };

    const originalQuerySelector = document.querySelector;
    document.querySelector = function(selector) {
      const result = originalQuerySelector.apply(this, arguments);
      if (!result) {
        if (
          selector &&
          typeof selector === "string" &&
          selector.includes("r-") &&
          !isEnsuringBotox
        ) {
          if (learnStatsigClassesFromSelector(selector)) {
            selectorMatchCache.clear?.();
            classMatchCache.clear?.();
          }
          ensureBotoxElements();
          const reResult = originalQuerySelector.apply(this, arguments);
          if (reResult) {
            return reResult;
          }
        }
        if (savedElements.length) {
          return getCachedSelectorMatches(selector)[0] ?? result;
        }
      }
      return result;
    };

    const originalGetElementsByClassName = document.getElementsByClassName;
    document.getElementsByClassName = function(className) {
      const result = originalGetElementsByClassName.apply(this, arguments);
      if (result.length === 0) {
        if (
          className &&
          typeof className === "string" &&
          className.startsWith("r-") &&
          !isEnsuringBotox
        ) {
          if (learnStatsigClassesFromSelector("." + className)) {
            selectorMatchCache.clear?.();
            classMatchCache.clear?.();
          }
          ensureBotoxElements();
          const reResult = originalGetElementsByClassName.apply(this, arguments);
          if (reResult.length) {
            return reResult;
          }
        }
        if (savedElements.length) {
          const matched = getCachedClassMatches(className);
          if (matched.length) {
            return matched;
          }
        }
      }
      return result;
    };
  } catch {}

  const getBinding = (name) => {
    if (typeof window[name] === "function") {
      return window[name];
    }

    const legacyName = name.startsWith("__") ? name.slice(2) : "";
    if (legacyName && typeof window[legacyName] === "function") {
      return window[legacyName];
    }

    return null;
  };

  const callBinding = async (name, payload) => {
    const binding = getBinding(name);
    if (!binding) {
      throw new Error(`window.${name} is not a function`);
    }

    await binding(payload);
  };

  window.__grokBridgeGetBinding = getBinding;
  window.grokBridgeGetBinding = getBinding;
  window.__grokBridgeCallBinding = callBinding;
  window.grokBridgeCallBinding = callBinding;

  if (typeof window.__grokBridgeEnsureStatsigGenerator !== "function") {
    const ensureStatsigGenerator = async (scriptUrl, targetModuleId) => {
      const sourceKey = `${scriptUrl}:${targetModuleId}`;
      // A page created before a Grok deploy can hold a generator from the
      // old build. The old chunk still loads fine, so nothing flags it
      // stale, but its DOM queries can crash against the new build with
      // TypeErrors ("childNodes" etc). Key the cache by the source that
      // produced the generator: after the server rediscovers the chunk
      // post-deploy, this page replaces its cached generator instead of
      // returning it forever. Pages without a recorded source (seeded
      // state) keep using their cached generator.
      if (
        window.__grokStatsigGen &&
        (!window.__grokStatsigGenSrc || window.__grokStatsigGenSrc === sourceKey)
      ) {
        return window.__grokStatsigGen;
      }

      const previous = globalThis.TURBOPACK;
      let moduleFactory = null;

      const interceptPromise = new Promise((resolve, reject) => {
        globalThis.TURBOPACK = {
          push(args) {
            if (args.length === 3 && (args[1] === targetModuleId || args[1] === Number(targetModuleId))) {
              moduleFactory = args[2];
            } else {
              for (let index = 1; index < args.length; index += 2) {
                if (args[index] === targetModuleId || args[index] === Number(targetModuleId)) {
                  moduleFactory = args[index + 1];
                }
              }
            }
            if (previous && typeof previous.push === "function") {
              previous.push(args);
            } else if (Array.isArray(previous)) {
              previous.push(args);
            }
            if (moduleFactory) {
              resolve();
            }
          }
        };

        const script = document.createElement("script");
        script.src = scriptUrl;
        script.onload = () => {
          if (!moduleFactory) {
            reject(new Error("Script loaded but module " + targetModuleId + " was not intercepted"));
          }
        };
        script.onerror = (e) => {
          reject(new Error("Failed to load script: " + scriptUrl));
        };
        document.head.appendChild(script);
      });

      try {
        await interceptPromise;
      } finally {
        globalThis.TURBOPACK = previous;
      }

      if (!moduleFactory) {
        throw new Error("Unable to load Grok statsig middleware for module " + targetModuleId);
      }

      const exports = {};
      const W = {
        s(defs) {
          if (Array.isArray(defs)) {
            const name = defs[0];
            const getter = defs[2] || defs[1];
            Object.defineProperty(exports, name, {
              enumerable: true,
              get: getter
            });
            return;
          }
        }
      };

      try {
        moduleFactory(W);
      } catch (e) {
        moduleFactory({
          s(defs) {
            for (let index = 0; index < defs.length; index += 2) {
              Object.defineProperty(exports, defs[index], {
                enumerable: true,
                get: defs[index + 1]
              });
            }
          }
        });
      }

      let gen = exports.default;
      if (typeof gen === "function") {
        try {
          const res = gen();
          if (typeof res === "function") {
            gen = res;
          }
        } catch (e) {}
      }
      window.__grokStatsigGenSrc = sourceKey;
      window.__grokStatsigGen = gen;
      return window.__grokStatsigGen;
    };

    window.__grokBridgeEnsureStatsigGenerator = ensureStatsigGenerator;
    window.grokBridgeEnsureStatsigGenerator = ensureStatsigGenerator;
  }

  window.__grokBridgeFetch = async (request) => {
    const controller = new AbortController();
    requestControllers.set(request.requestId, controller);

    try {
      const url = new URL(request.url, location.origin);
      let statsigId = null;
      try {
        // Apply the per-deploy branding data extracted by the server so the
        // botox stand-ins carry the exact curves/css_class the middleware
        // and xAI expect before the first statistics attempt runs.
        if (
          request &&
          typeof request === "object" &&
          (Array.isArray(request.statsigCurves) ||
            request.statsigBrandCssClass ||
            request.statsigMetaContent)
        ) {
          if (Array.isArray(request.statsigCurves) && request.statsigCurves.length >= 2) {
            statsigSeed.curves = request.statsigCurves;
          }
          if (typeof request.statsigBrandCssClass === "string") {
            learnStatsigCssClass(request.statsigBrandCssClass);
          }
          if (typeof request.statsigMetaContent === "string" && !knownStatsigMetaContent) {
            knownStatsigMetaContent = request.statsigMetaContent;
          }
        }
        ensureBotoxElements();
        if (window.__grokVerbose) {
          console.log("__grokBridgeFetch: statsig generator cache size:", savedElements.length);
        }
        const generator = await window.__grokBridgeEnsureStatsigGenerator(
          request.statsigChunkUrl,
          request.statsigModuleId
        );
        if (typeof generator !== "function") {
          throw new Error("Grok statsig generator is not a function");
        }

        // The statsig middleware reads the app's DOM, so on a freshly opened
        // page it can fail before the Grok app has mounted. Retry with a
        // short delay instead of sending a placeholder id: xAI rejects
        // placeholder ids with "Request rejected by anti-bot rules.".
        const maxStatsigAttempts = Number(request.statsigMaxAttempts) || 50;
        const statsigRetryDelayMs = Number(request.statsigRetryDelayMs) || 50;
        // Deterministic failures (a stale middleware build querying a DOM
        // node the new build no longer provides) repeat the exact same error
        // forever; retrying them burns the whole budget. Bail once the same
        // error has repeated for this long and let the server-side
        // rediscovery/recreate path take over. Genuinely transient failures
        // (app still mounting) resolve far earlier on a healthy pipeline.
        const identicalBailMs =
          Number(request.statsigIdenticalBailMs) > 0
            ? Number(request.statsigIdenticalBailMs)
            : 5000;
        let lastError = null;
        let lastErrorMessage = null;
        let identicalErrorStreakStartedAt = null;
        // If the page redirected to a login/onboarding screen the Grok app
        // never mounts, so the statsig generator can never succeed. Bail out
        // after the first failed attempt instead of burning the whole budget.
        const isLoginRedirect = () => {
          try {
            if (typeof location === "undefined") {
              return false;
            }
            return /^\/(login|signin|sign-in|signup|sign-up|register|magic-link)(\/|$)/.test(
              location.pathname || ""
            );
          } catch {
            return false;
          }
        };
        for (let attempt = 0; attempt < maxStatsigAttempts; attempt += 1) {
          try {
            ensureBotoxElements();
            statsigId = await generator(url.pathname, request.method);
            break;
          } catch (error) {
            lastError = error;
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage === lastErrorMessage) {
              if (identicalErrorStreakStartedAt == null) {
                identicalErrorStreakStartedAt = Date.now();
              } else if (Date.now() - identicalErrorStreakStartedAt >= identicalBailMs) {
                throw new Error(`Grok statsig id generation failed: ${errorMessage}`);
              }
            } else {
              lastErrorMessage = errorMessage;
              identicalErrorStreakStartedAt = Date.now();
            }
            if (window.__grokVerbose) {
              console.error(
                `__grokBridgeFetch: statsig id attempt ${attempt + 1}/${maxStatsigAttempts} failed:`,
                error
              );
            }
            if (attempt % 25 === 0 && isLoginRedirect()) {
              throw new Error(
                `redirected to login page (${location.pathname || ""})`
              );
            }
            if (attempt < maxStatsigAttempts - 1) {
              await new Promise((resolve) => setTimeout(resolve, statsigRetryDelayMs));
            }
          }
        }

        if (!statsigId) {
          throw new Error(
            `Grok statsig id generation failed: ${
              lastError instanceof Error ? lastError.message : String(lastError)
            }`
          );
        }
        if (window.__grokVerbose) {
          console.log("__grokBridgeFetch: Generated statsigId successfully:", statsigId);
        }
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const normalizedMessage = rawMessage.toLowerCase();
        // Inlined literals: this helper is injected into the page via
        // toString(), so module-scope constants are not reachable here.
        const staleChunk =
          normalizedMessage.includes("not intercepted") ||
          normalizedMessage.includes("failed to load script") ||
          normalizedMessage.includes("unable to load grok statsig middleware");
        throw new Error(
          `${staleChunk ? "__grokBridgeStatsigChunkStale" : "__grokBridgeStatsigFailed"}: ${rawMessage}`
        );
      }
      const headers = new Headers(request.headers || {});
      headers.set("x-xai-request-id", crypto.randomUUID());
      headers.set("x-statsig-id", statsigId);

      if (window.__grokVerbose) {
        console.log("__grokBridgeFetch Request URL:", request.url);
        console.log("__grokBridgeFetch Request Method:", request.method);
        console.log("__grokBridgeFetch Request Headers:", JSON.stringify(request.headers));
        console.log("__grokBridgeFetch Request Body:", JSON.stringify(request.body));
      }

      try {
        await window.__grokBridgeCallBinding("__grokBridgeDispatched", {
          requestId: request.requestId
        });
      } catch {}

      const response = await fetch(request.url, {
        method: request.method,
        headers,
        body: request.body ? JSON.stringify(request.body) : undefined,
        credentials: "include",
        signal: controller.signal
      });

      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      await window.__grokBridgeCallBinding("__grokBridgeMeta", {
        requestId: request.requestId,
        status: response.status,
        headers: responseHeaders
      });

      if (!response.body) {
        await window.__grokBridgeCallBinding("__grokBridgeDone", {
          requestId: request.requestId
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const requestedBatchMaxChars = Number(request.streamBatchMaxChars);
      const requestedBatchDelayMs = Number(request.streamBatchDelayMs);
      const batchMaxChars =
        Number.isFinite(requestedBatchMaxChars) && requestedBatchMaxChars > 0
          ? Math.floor(requestedBatchMaxChars)
          : 16384;
      const batchDelayMs =
        Number.isFinite(requestedBatchDelayMs) && requestedBatchDelayMs >= 0
          ? requestedBatchDelayMs
          : 2;
      let bufferedChunk = "";
      let flushTimer = null;
      let flushError = null;
      let flushChain = Promise.resolve();

      const flushBufferedChunk = () => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }

        if (!bufferedChunk || flushError) {
          return flushChain;
        }

        const chunk = bufferedChunk;
        bufferedChunk = "";
        flushChain = flushChain
          .then(() => window.__grokBridgeCallBinding("__grokBridgeChunk", {
            requestId: request.requestId,
            chunk
          }))
          .catch((error) => {
            flushError ??= error;
          });

        return flushChain;
      };

      const queueChunk = async (chunk) => {
        if (!chunk) {
          return;
        }

        bufferedChunk += chunk;
        if (bufferedChunk.length >= batchMaxChars) {
          await flushBufferedChunk();
          if (flushError) {
            throw flushError;
          }
          return;
        }

        if (flushTimer === null) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flushBufferedChunk();
          }, batchDelayMs);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        await queueChunk(chunk);
      }

      const finalChunk = decoder.decode();
      await queueChunk(finalChunk);
      await flushBufferedChunk();
      if (flushError) {
        throw flushError;
      }

      await window.__grokBridgeCallBinding("__grokBridgeDone", {
        requestId: request.requestId
      });
    } catch (error) {
      try {
        const errorMsg = error instanceof Error ? `${error.name}: ${error.message}\nStack: ${error.stack}` : String(error);
        await window.__grokBridgeCallBinding("__grokBridgeError", {
          requestId: request.requestId,
          message: errorMsg,
          status:
            error && typeof error === "object" && Number.isInteger(error.status)
              ? error.status
              : undefined,
          details: error?.details ?? undefined
        });
      } catch {
        throw error;
      }
    } finally {
      requestControllers.delete(request.requestId);
    }
  };

  window.grokBridgeFetch = window.__grokBridgeFetch;
}

function isRecoverablePageError(message) {
  const normalized = String(message || "").toLowerCase();

  return (
    normalized.includes("execution context was destroyed") ||
    normalized.includes("most likely because of a navigation") ||
    normalized.includes("target closed") ||
    normalized.includes("target page, context or browser has been closed") ||
    ((normalized.includes("__grokbridge") || normalized.includes("grokbridge")) &&
      (normalized.includes("is not a function") ||
        normalized.includes("is undefined")))
  );
}

export function isRecoverableContextError(message) {
  const normalized = String(message || "").toLowerCase();

  if (normalized.includes("target page, context or browser has been closed")) {
    return false;
  }

  return (
    normalized.includes("target.createtarget") ||
    normalized.includes("failed to open a new tab") ||
    normalized.includes("browsercontext.newpage") ||
    normalized.includes("browser has been closed") ||
    normalized.includes("context has been closed") ||
    normalized.includes("connection closed") ||
    (normalized.includes("protocol error") &&
      (normalized.includes("target") ||
        normalized.includes("context") ||
        normalized.includes("browser") ||
        normalized.includes("page")))
  );
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function isCloudflareBlockText(text = "") {
  const normalized = String(text).toLowerCase();

  return (
    normalized.includes("attention required! | cloudflare") ||
    normalized.includes("sorry, you have been blocked") ||
    normalized.includes("checking if the site connection is secure") ||
    normalized.includes("cf-error-details") ||
    normalized.includes("cloudflare ray id")
  );
}

function createSessionBlockedError(reason) {
  return new HttpError(
    502,
    `Grok session is blocked or not authenticated: ${reason}`,
    {
      code: GROK_SESSION_BLOCKED_ERROR_CODE
    }
  );
}

function isPrimaryNavigationResponse(page, response) {
  if (!response) {
    return false;
  }

  const request = typeof response.request === "function" ? response.request() : null;
  const frame = typeof response.frame === "function" ? response.frame() : null;
  const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : null;

  if (mainFrame && frame && frame !== mainFrame) {
    return false;
  }

  if (!request) {
    return true;
  }

  if (typeof request.isNavigationRequest === "function" && request.isNavigationRequest()) {
    return true;
  }

  if (typeof request.resourceType === "function" && request.resourceType() === "document") {
    return true;
  }

  return false;
}

function getResponseStatus(response) {
  if (!response) {
    return 0;
  }

  return typeof response.status === "function" ? response.status() : response.status;
}

function getResponseHeaders(response) {
  if (!response) {
    return {};
  }

  return typeof response.headers === "function" ? response.headers() : (response.headers ?? {});
}

async function getResponseBody(response) {
  if (!response) {
    return Buffer.alloc(0);
  }

  const body =
    typeof response.body === "function" ? await response.body() : response.body;

  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

const globalStatsigCache = new Map();
let globalStatsigInFlightPromise = null;

// The site-verification token (meta[name^="gr"]) is injected by the app at
// boot on every page and is static per deploy. Remember the first token any
// page reports so wedged pages (app never mounted) can re-inject it and
// still generate statsig ids.
let globalStatsigMetaToken = null;

// Grok's statsig middleware fingerprints the "loading X" logo: it queries
// the logo by a per-deploy obfuscated class and folds the curve path data
// into the id. The app embeds the curve data + css_class in the __next_f
// payload of the /login route (the homepage boot payload no longer carries
// it). Extract it once per deploy and pass it to the in-page bridge so its
// botox stand-ins carry the exact values xAI expects, otherwise generated
// ids are rejected with "Request rejected by anti-bot rules.".
const globalStatsigBranding = new Map();
let globalStatsigBrandingPromise = null;

function extractNextFPayloads(html) {
  const payloads = [];
  const pushRe = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"/g;
  let match = null;
  let guard = 0;
  while ((match = pushRe.exec(html)) !== null && guard < 200) {
    guard += 1;
    try {
      payloads.push(JSON.parse(`"${match[1]}"`));
    } catch {}
  }
  return payloads;
}

export function extractStatsigBrandingFromHtml(html) {
  for (const text of extractNextFPayloads(html)) {
    if (typeof text !== "string" || !text.includes("css_class")) {
      continue;
    }
    const idx = text.indexOf('"css_class"');
    const startIdx = text.lastIndexOf('{"curves":', idx);
    if (startIdx === -1) {
      continue;
    }
    const slice = text.slice(startIdx);
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < slice.length; i += 1) {
      if (slice[i] === "{") {
        depth += 1;
      } else if (slice[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          endIdx = i + 1;
          break;
        }
      }
    }
    if (endIdx === -1) {
      continue;
    }
    try {
      const parsed = JSON.parse(slice.slice(0, endIdx));
      if (
        Array.isArray(parsed.curves) &&
        parsed.curves.length >= 2 &&
        typeof parsed.css_class === "string"
      ) {
        return {
          curves: parsed.curves,
          cssClass: parsed.css_class
        };
      }
    } catch {}
  }
  return null;
}

export async function fetchStatsigBranding(grokBaseUrl) {
  const loginUrl = `${grokBaseUrl}/login`;
  try {
    const res = await fetch(loginUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
      },
      signal: AbortSignal.timeout(15000)
    });
    const contentType = String(res.headers.get?.("content-type") ?? "");
    if (!res.ok && !contentType.includes("text/html")) {
      // grok.com currently serves /login as HTTP 404 while still returning
      // the full app HTML (anti-bot routing); the branding payload is in
      // the body either way. Only non-HTML failures (challenge pages,
      // network errors) are fatal — the extractor returns null for those.
      return null;
    }
    const html = await res.text();
    return extractStatsigBrandingFromHtml(html);
  } catch {
    return null;
  }
}

const STATSIG_BRANDING_CACHE_TTL_MS = 15 * 60 * 1000;

async function loadGlobalStatsigBranding(grokBaseUrl) {
  const cached = globalStatsigBranding.get(grokBaseUrl);
  if (cached && Date.now() - cached.at < STATSIG_BRANDING_CACHE_TTL_MS) {
    return cached.branding;
  }
  if (globalStatsigBrandingPromise) {
    return globalStatsigBrandingPromise;
  }
  const promise = (async () => {
    try {
      return await fetchStatsigBranding(grokBaseUrl);
    } finally {
      globalStatsigBrandingPromise = null;
    }
  })();
  globalStatsigBrandingPromise = promise;
  const branding = await promise;
  if (branding) {
    // Cache per deploy: curves/css_class rotate when Grok ships a new
    // build, so an entry older than the TTL is re-extracted on demand.
    globalStatsigBranding.set(grokBaseUrl, { branding, at: Date.now() });
  }
  return branding;
}

export class BrowserSession {
  constructor(config) {
    this.config = config;
    this.context = null;
    this.page = null;
    this.pagePromise = null;
    this.pageUserAgent = null;
    this.branding = null;
    this.brandingPromise = null;
    this.brandingLoadedAt = null;
    this.pending = new Map();
    this.statsigChunkUrl = null;
    this.statsigModuleId = null;
    this.statsigPromise = null;
    this.bindingsInstalled = false;
    this.initPromise = null;
    this.closePromise = null;
    this.validatedPage = null;
    this.validatedPageUrl = null;
  }

  async loadStatsigBranding() {
    if (
      this.brandingLoadedAt &&
      Date.now() - this.brandingLoadedAt < STATSIG_BRANDING_CACHE_TTL_MS
    ) {
      return this.branding;
    }
    if (this.brandingPromise) {
      return this.brandingPromise;
    }
    const promise = loadGlobalStatsigBranding(this.config.grokBaseUrl);
    this.brandingPromise = promise;
    try {
      this.branding = await promise;
      return this.branding;
    } finally {
      this.brandingLoadedAt = Date.now();
      this.brandingPromise = null;
    }
  }

  resetContextState() {
    this.context = null;
    this.page = null;
    this.pagePromise = null;
    this.pageUserAgent = null;
    this.statsigChunkUrl = null;
    this.statsigModuleId = null;
    this.statsigPromise = null;
    this.bindingsInstalled = false;
    this.validatedPage = null;
    this.validatedPageUrl = null;
  }

  async loadStatsigChunkSource() {
    if (this.statsigChunkUrl && this.statsigModuleId) {
      return {
        url: this.statsigChunkUrl,
        moduleId: this.statsigModuleId
      };
    }

    const cacheKey = this.config.grokBaseUrl;
    const cached = globalStatsigCache.get(cacheKey);
    if (cached) {
      this.statsigChunkUrl = cached.url;
      this.statsigModuleId = cached.moduleId;
      return cached;
    }

    if (globalStatsigInFlightPromise) {
      const result = await globalStatsigInFlightPromise;
      this.statsigChunkUrl = result.url;
      this.statsigModuleId = result.moduleId;
      return result;
    }

    const statsigPromise = (async () => {
      try {
        return await this.discoverStatsigChunkSource(cacheKey);
      } finally {
        globalStatsigInFlightPromise = null;
      }
    })();
    globalStatsigInFlightPromise = statsigPromise;

    const discovered = await statsigPromise;
    this.statsigChunkUrl = discovered.url;
    this.statsigModuleId = discovered.moduleId;
    return discovered;
  }

  async discoverStatsigChunkSource(cacheKey) {
    const page = await this.ensurePage();

    // Grok's page bootstraps its /_next/static/chunks/ scripts asynchronously,
    // so a freshly-opened page may not have them in the DOM yet. Re-scan a few
    // times with a short delay instead of failing the very first request.
    const maxAttempts = 5;
    const attemptDelayMs = 1000;
    let urls = [];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      urls = await page.evaluate(() =>
        Array.from(document.querySelectorAll("script"))
          .map((s) => s.src)
          .filter((src) => src && src.includes("/_next/static/chunks/"))
      );

      if (urls.length) {
        break;
      }
      if (attempt < maxAttempts - 1) {
        if (typeof page.waitForTimeout === "function") {
          await page.waitForTimeout(attemptDelayMs);
        } else {
          await new Promise((resolve) => setTimeout(resolve, attemptDelayMs));
        }
      }
    }

    if (urls.length < 10) {
      try {
        const pageUrl = page.url() || "https://grok.com";
        const htmlRes = await fetch(pageUrl, { signal: AbortSignal.timeout(5000) });
        if (htmlRes.ok) {
          const html = await htmlRes.text();
          const matches = Array.from(
            html.matchAll(/src="([^"]+\/_next\/static\/chunks\/[^"]+)"/g)
          ).map((m) => m[1]);
          for (const m of matches) {
            const fullUrl = m.startsWith("http") ? m : new URL(m, pageUrl).href;
            if (!urls.includes(fullUrl)) {
              urls.push(fullUrl);
            }
          }
        }
      } catch {}
    }

    if (!urls.length) {
      throw new Error("No Next.js static chunks found on Grok page");
    }

    const fetchChunk = async (url) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          return await res.text();
        }
      } catch {}
      return null;
    };

    let middlewareUrl = null;
    let statsigModuleId = null;
    let generatorChunkRelativePath = null;
    let targetInnerModuleId = null;

    const chunkTexts = {};
    const concurrency = 15;

    for (let i = 0; i < urls.length; i += concurrency) {
      const batch = urls.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(fetchChunk));

      for (let j = 0; j < batch.length; j++) {
        const text = results[j];
        if (!text) continue;
        const url = batch[j];
        chunkTexts[url] = text;

        if (!statsigModuleId && text.includes("x-statsig-id")) {
          middlewareUrl = url;
          const idx = text.indexOf("x-statsig-id");
          const legacyMatch = /\.([a-zA-Z_0-9]+)\((\d+)\)\.then\(/g.exec(text);
          if (legacyMatch) {
            statsigModuleId = legacyMatch[2];
          } else {
            const snippet = text.slice(Math.max(0, idx - 1500), idx);
            const matches = Array.from(snippet.matchAll(/\b[a-zA-Z_0-9\.]+\((\d{5,})\)/g));
            if (matches.length) {
              statsigModuleId = matches[matches.length - 1][1];
            }
          }
        }
      }

      if (statsigModuleId) {
        for (const [url, text] of Object.entries(chunkTexts)) {
          if (text.includes(statsigModuleId) && url !== middlewareUrl) {
            const broadRegex = new RegExp(
              statsigModuleId +
                '[^}]+?"(static/chunks/[^"]+)"[^}]+?\\.then\\(\\(\\)\\s*=>\\s*[a-zA-Z_0-9]+\\(([^\\)]+)\\)\\)'
            );
            const match = broadRegex.exec(text);
            if (match) {
              generatorChunkRelativePath = match[1];
              targetInnerModuleId = match[2];
              break;
            }
          }
        }

        if (generatorChunkRelativePath && targetInnerModuleId) {
          break;
        }
      }
    }

    if (!middlewareUrl || !statsigModuleId) {
      throw new Error("Could not find statsig module ID in chunks");
    }

    if (!generatorChunkRelativePath || !targetInnerModuleId) {
      for (const [url, text] of Object.entries(chunkTexts)) {
        if (text.includes(statsigModuleId) && url !== middlewareUrl) {
          const broadRegex = new RegExp(
            statsigModuleId +
              '[^}]+?"(static/chunks/[^"]+)"[^}]+?\\.then\\(\\(\\)\\s*=>\\s*[a-zA-Z_0-9]+\\(([^\\)]+)\\)\\)'
          );
          const match = broadRegex.exec(text);
          if (match) {
            generatorChunkRelativePath = match[1];
            targetInnerModuleId = match[2];
            break;
          }
        }
      }
    }

    if (!generatorChunkRelativePath || !targetInnerModuleId) {
      throw new Error("Could not find dynamic import definition for statsig module");
    }

    const generatorUrl = `${this.config.grokBaseUrl}/_next/${generatorChunkRelativePath}`;

    let numericModuleId = Number(targetInnerModuleId);
    if (isNaN(numericModuleId)) {
      try {
        numericModuleId = Function(`return (${targetInnerModuleId})`)();
      } catch {
        throw new Error(`Could not parse targetInnerModuleId: ${targetInnerModuleId}`);
      }
    }

    this.statsigChunkUrl = generatorUrl;
    this.statsigModuleId = numericModuleId;

    const discovered = {
      url: this.statsigChunkUrl,
      moduleId: this.statsigModuleId
    };
    globalStatsigCache.set(cacheKey, discovered);

    return discovered;
  }

  async init() {
    if (this.context) {
      await this.ensurePage();
      return;
    }

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    const initPromise = (async () => {
      if (this.context) {
        await this.ensurePage();
        return;
      }

      if (this.config.browserProfileDir) {
        await fs.mkdir(this.config.browserProfileDir, { recursive: true });
      }

      const context = await chromium.launchPersistentContext(
        this.config.browserProfileDir,
        {
          headless: this.config.headless,
          executablePath: this.config.chromeExecutablePath || undefined,
          // Memory guardrail: cap each renderer's V8 old space so a
          // long-lived page cannot balloon its heap over days of uptime.
          // The Grok SPA and the streaming bridge work far below 512 MB, so
          // this never causes GC pressure on normal traffic. (Chromium flags
          // like --process-per-site / --disable-gpu were measured inert
          // here: site isolation keeps cross-origin renderers, and headless
          // always spawns its GPU process for SwiftShader compositing.)
          args: ["--js-flags=--max-old-space-size=512"]
        }
      );
      this.context = context;

      try {
        await this.installBindings();

        if (this.config.importCookiesOnBoot) {
          const cookies = Array.isArray(this.config.grokCookies)
            ? this.config.grokCookies
            : await readCookiesFromSource({
                filePath: this.config.grokCookieFile,
                rawText: this.config.grokCookiesText
              });

          if (cookies.length) {
            await this.context.addCookies(cookies);
          }
        }

        await this.ensurePage();
      } catch (error) {
        await context.close().catch(() => {});
        if (this.context === context) {
          this.resetContextState();
        }
        throw error;
      }
    })();

    this.initPromise = initPromise;

    try {
      await initPromise;
    } finally {
      if (this.initPromise === initPromise) {
        this.initPromise = null;
      }
    }
  }

  async installBindings() {
    if (this.bindingsInstalled) {
      return;
    }

    const exposeAliases = async (names, handler) => {
      for (const name of names) {
        await this.context.exposeBinding(name, handler);
      }
    };

    await exposeAliases(["__grokBridgeDispatched", "grokBridgeDispatched"], (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      pending?.onDispatched?.();
    });

    await exposeAliases(["__grokBridgeMeta", "grokBridgeMeta"], (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      pending?.onMeta(payload);
    });

    await exposeAliases(["__grokBridgeChunk", "grokBridgeChunk"], (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      pending?.onChunk(payload.chunk);
    });

    await exposeAliases(["__grokBridgeDone", "grokBridgeDone"], (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.requestId);
      pending.resolve();
    });

    await exposeAliases(["__grokBridgeError", "grokBridgeError"], (_source, payload) => {
      const pending = this.pending.get(payload.requestId);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.requestId);
      pending.reject(
        new HttpError(
          payload.status ?? 502,
          payload.message || "Grok request failed",
          payload.details ?? {}
        )
      );
    });

    await exposeAliases(["__grokBridgeStatsigMeta", "grokBridgeStatsigMeta"], (_source, payload) => {
      if (payload && typeof payload.content === "string" && payload.content) {
        globalStatsigMetaToken = payload.content;
      }
    });

    await this.context.addInitScript(`
      window.__grokVerbose = ${!!this.config?.verbose};
      (${installGrokBridgePageHelpers.toString()})();
    `);

    this.bindingsInstalled = true;
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed()) {
      const pageUrl = typeof this.page.url === "function" ? this.page.url() : "";
      if (
        this.validatedPage === this.page &&
        this.validatedPageUrl === pageUrl
      ) {
        return this.page;
      }

      try {
        await this.validatePage(this.page);
        this.validatedPage = this.page;
        this.validatedPageUrl = pageUrl;
        return this.page;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRecoverableContextError(msg)) {
          return this.recreateContext();
        }
        this.page = null;
      }
    }

    if (this.pagePromise) {
      return this.pagePromise;
    }

    const pagePromise = (async () => {
      if (!this.context) {
        await this.init();
      }

      let page;
      try {
        page = await this.context.newPage();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRecoverableContextError(msg)) {
          return this.recreateContext();
        }
        throw err;
      }

      page.on("console", (msg) => {
        if (this.config?.verbose) {
          console.log(`[BROWSER CONSOLE] [${msg.type()}] ${msg.text()}`);
        }
      });
      this.page = page;
      this.validatedPage = null;
      this.validatedPageUrl = null;
      page.on("close", () => {
        if (this.page === page) {
          this.page = null;
          this.pageUserAgent = null;
          this.validatedPage = null;
          this.validatedPageUrl = null;
        }
      });
      page.on("framenavigated", (frame) => {
        const mainFrame = typeof page.mainFrame === "function" ? page.mainFrame() : null;
        if (this.page === page && (!mainFrame || frame === mainFrame)) {
          this.validatedPage = null;
          this.validatedPageUrl = null;
        }
      });

      try {
        const response = await page.goto(this.config.grokBaseUrl, {
          waitUntil: "domcontentloaded"
        });
        try {
          const readinessTimeout = this.config.browserNetworkIdleTimeoutMs ?? 1000;
          await page.waitForFunction(
            () =>
              (Array.isArray(window.__next_f) && window.__next_f.length > 0) ||
              document.querySelectorAll("textarea, [contenteditable=\"true\"], input, path[d]").length > 0,
            { timeout: readinessTimeout }
          );
        } catch (e) {}
        if (this.config.browserPageLoadDelayMs > 0) {
          try {
            await page.waitForTimeout(this.config.browserPageLoadDelayMs);
          } catch (e) {}
        }
        await this.validatePage(page, response);
        this.validatedPage = page;
        this.validatedPageUrl = typeof page.url === "function" ? page.url() : "";

        try {
          this.pageUserAgent = await page.evaluate(() => navigator.userAgent);
        } catch {
          this.pageUserAgent = null;
        }

        return page;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRecoverableContextError(msg)) {
          return this.recreateContext();
        }
        throw err;
      }
    })();

    this.pagePromise = pagePromise;

    try {
      return await pagePromise;
    } finally {
      if (this.pagePromise === pagePromise) {
        this.pagePromise = null;
      }
    }
  }

  async recreatePage() {
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
    this.page = null;
    this.validatedPage = null;
    this.validatedPageUrl = null;
    try {
      return await this.ensurePage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRecoverableContextError(message)) {
        return this.recreateContext();
      }
      throw error;
    }
  }

  async recreateContext() {
    const context = this.context;
    this.resetContextState();
    await context?.close().catch(() => {});
    await this.init();
    return this.ensurePage();
  }

  async dismissModals(page) {
    try {
      const result = await page.evaluate(() => {
        const dialogs = Array.from(
          document.querySelectorAll(
            'dialog, [role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="banner" i], [class*="consent" i], [id*="modal" i], [id*="banner" i], [id*="consent" i]'
          )
        );

        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const targets = [
          "got it",
          "accept",
          "accept all",
          "agree",
          "i agree",
          "allow",
          "allow all",
          "close",
          "gotit",
          "continue",
          "dismiss"
        ];

        for (const dialog of dialogs) {
          if (!isVisible(dialog)) continue;
          const text = (dialog.innerText || dialog.textContent || "").toLowerCase();
          const isTosOrConsent =
            text.includes("terms") ||
            text.includes("policy") ||
            text.includes("cookie") ||
            text.includes("consent") ||
            text.includes("welcome") ||
            text.includes("update");

          if (!isTosOrConsent) continue;

          const buttons = Array.from(
            dialog.querySelectorAll(
              'button, div[role="button"], a[role="button"], input[type="button"], span[role="button"]'
            )
          );

          for (const btn of buttons) {
            if (!isVisible(btn)) continue;
            const btnText = (
              btn.innerText ||
              btn.textContent ||
              btn.getAttribute("aria-label") ||
              ""
            )
              .trim()
              .toLowerCase();
            if (targets.includes(btnText)) {
              btn.click();
              return { clicked: true, text: btnText, elementClass: btn.className };
            }
          }
        }

        return { clicked: false, reason: "No active modal found" };
      });

      if (result?.clicked) {
        console.warn(`[BrowserSession] Dismissed modal by clicking "${result.text}" button.`);
        if (typeof page.waitForTimeout === "function") {
          await page.waitForTimeout(200);
        }
      }
    } catch (error) {
      // Ignore errors during evaluation
    }
  }

  async validatePage(page, response = null) {
    const expectedOrigin = getOrigin(this.config.grokBaseUrl);
    const pageUrl = typeof page.url === "function" ? page.url() : "";
    const pageOrigin = getOrigin(pageUrl);

    if (expectedOrigin && pageOrigin && pageOrigin === expectedOrigin) {
      await this.dismissModals(page);

      let pagePathname = "";
      try {
        pagePathname = new URL(pageUrl).pathname.toLowerCase();
      } catch {}

      if (
        pagePathname === "/login" ||
        pagePathname === "/signin" ||
        pagePathname === "/sign-in" ||
        pagePathname === "/register" ||
        pagePathname === "/signup"
      ) {
        throw createSessionBlockedError(`redirected to login page (${pagePathname})`);
      }
    }

    const readPageSnapshot = () =>
      page.evaluate(() => ({
        title: document.title || "",
        text: document.body?.innerText?.slice(0, 1000) || ""
      })).catch(() => ({ title: "", text: "" }));

    if (expectedOrigin && pageOrigin && pageOrigin !== expectedOrigin) {
      const pageSnapshot = await readPageSnapshot();
      const title = pageSnapshot.title || "";
      const text = pageSnapshot.text || "";

      if (isCloudflareBlockText(`${title}\n${text}`)) {
        throw createSessionBlockedError(
          `Cloudflare block page at ${pageOrigin}`
        );
      }

      throw createSessionBlockedError(
        `redirected from ${expectedOrigin} to ${pageOrigin}`
      );
    }

    const status = getResponseStatus(response);
    if (status === 403 || status === 429 || status === 503) {
      const pageSnapshot = await readPageSnapshot();

      if (isCloudflareBlockText(`${pageSnapshot.title}\n${pageSnapshot.text}`)) {
        throw createSessionBlockedError(
          `Cloudflare returned HTTP ${status}`
        );
      }
    }

    if (response) {
      const pageSnapshot = await readPageSnapshot();
      if (isCloudflareBlockText(`${pageSnapshot.title}\n${pageSnapshot.text}`)) {
        throw createSessionBlockedError("Cloudflare block page");
      }
    }
  }

  async evaluateRequest(page, payload) {
    return page.evaluate((requestPayload) => window.__grokBridgeFetch(requestPayload), payload);
  }

  async abortRequest(page, requestId) {
    return page
      .evaluate(
        (activeRequestId) =>
          window.__grokBridgeAbortRequest?.(activeRequestId) ?? false,
        requestId
      )
      .catch(() => false);
  }

  accountLabel() {
    const dir = this.config.browserProfileDir || "";
    const base = typeof dir === "string" ? dir.split(/[\\/]/).pop() : "";
    return base || "default";
  }

  async request({
    requestId,
    url,
    method = "GET",
    body = null,
    headers = {},
    onChunk = null,
    onMeta = null
  }) {
    const requestStartedAt = Date.now();
    let statsigLoadedAt = 0;
    let pageReadyAt = 0;
    let firstByteAt = 0;
    const label = this.accountLabel();

    await this.init();
    await this.loadStatsigChunkSource();
    // Real logo curve data + css_class for the in-page botox stand-ins.
    // Without the exact per-deploy values xAI rejects the generated id.
    await this.loadStatsigBranding();
    statsigLoadedAt = Date.now();

    let meta = null;
    const textBuffer = {
      chunks: [],
      length: 0,
      limit: onChunk ? 0 : Number.POSITIVE_INFINITY
    };
    const buildPayload = () => ({
      requestId,
      url,
      method,
      body,
      headers,
      statsigChunkUrl: this.statsigChunkUrl,
      statsigModuleId: this.statsigModuleId,
      statsigMaxAttempts: this.config.browserStatsigMaxAttempts ?? 50,
      statsigRetryDelayMs: this.config.browserStatsigRetryDelayMs ?? 50,
      streamBatchMaxChars: this.config.browserStreamBatchMaxChars,
      streamBatchDelayMs: this.config.browserStreamBatchDelayMs,
      statsigCurves: this.branding?.curves ?? null,
      statsigBrandCssClass: this.branding?.cssClass ?? null,
      statsigMetaContent: globalStatsigMetaToken ?? null
    });
    let payload = buildPayload();
    let statsigChunkRetried = false;
    let statsigFailedRetried = false;
    let ttfbRetried = false;

    const run = async (page) => {
      pageReadyAt = Date.now();
      await new Promise((resolve, reject) => {
        const configuredTimeout = Number(this.config.browserRequestTimeoutMs);
        const timeoutMs =
          Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? configuredTimeout
            : 10 * 60 * 1000;
        const ttfbConfigured = Number(this.config.browserTtfbTimeoutMs);
        const ttfbTimeoutMs =
          Number.isFinite(ttfbConfigured) && ttfbConfigured > 0
            ? ttfbConfigured
            : 45 * 1000;
        let timeout;
        let ttfbTimer = null;
        const startTtfbTimer = () => {
          if (ttfbTimer || meta) {
            return;
          }

          ttfbTimer = setTimeout(() => {
            ttfbTimer = null;
            void this.abortRequest(page, requestId).catch(() => {});
            finish(
              reject,
              new HttpError(
                504,
                `Grok request produced no response within ${ttfbTimeoutMs} ms`,
                { code: GROK_REQUEST_TIMEOUT_ERROR_CODE }
              )
            );
          }, ttfbTimeoutMs);
          ttfbTimer.unref?.();
        };
        const clearTtfbTimer = () => {
          if (ttfbTimer) {
            clearTimeout(ttfbTimer);
            ttfbTimer = null;
          }
        };
        const finish = (callback, value) => {
          clearTimeout(timeout);
          clearTtfbTimer();
          this.pending.delete(requestId);
          callback(value);
        };

        this.pending.set(requestId, {
          onDispatched() {
            // The in-page fetch left the page; response headers must follow
            // within the TTFB deadline or the page is wedged.
            startTtfbTimer();
          },
          onMeta(payload) {
            meta = payload;
            clearTtfbTimer();
            if (!firstByteAt) {
              firstByteAt = Date.now();
            }

            if (payload.status >= 400) {
              setTextBufferLimit(textBuffer, ERROR_RESPONSE_TEXT_LIMIT);
            } else if (onChunk) {
              setTextBufferLimit(textBuffer, 0);
            }

            onMeta?.(payload);
          },
          onChunk(chunk) {
            if (!firstByteAt) {
              firstByteAt = Date.now();
            }
            appendTextChunk(textBuffer, chunk);
            onChunk?.(chunk);
          },
          resolve() {
            finish(resolve);
          },
          reject(error) {
            finish(reject, error);
          }
        });

        timeout = setTimeout(() => {
          void this.abortRequest(page, requestId);
          finish(
            reject,
            new HttpError(
              504,
              `Grok request timed out after ${timeoutMs} ms`,
              { code: GROK_REQUEST_TIMEOUT_ERROR_CODE }
            )
          );
        }, timeoutMs);

        this.evaluateRequest(page, payload).catch((error) => {
          finish(reject, error);
        });
      });
    };

    try {
      const page = await this.ensurePage();
      await run(page);
    } catch (error) {
      this.pending.delete(requestId);

      const message = error instanceof Error ? error.message : String(error);
      if (isRecoverableContextError(message)) {
        meta = null;
        setTextBufferLimit(
          textBuffer,
          onChunk ? 0 : Number.POSITIVE_INFINITY
        );
        clearTextBuffer(textBuffer);
        const page = await this.recreateContext();
        await run(page);
      } else if (isRecoverablePageError(message)) {
        meta = null;
        setTextBufferLimit(
          textBuffer,
          onChunk ? 0 : Number.POSITIVE_INFINITY
        );
        clearTextBuffer(textBuffer);
        let page;
        try {
          page = await this.recreatePage();
        } catch (recreateErr) {
          const recMsg = recreateErr instanceof Error ? recreateErr.message : String(recreateErr);
          if (isRecoverableContextError(recMsg)) {
            page = await this.recreateContext();
          } else {
            throw recreateErr;
          }
        }
        await run(page);
      } else if (
        message.includes(STATSIG_CHUNK_STALE_MARKER) &&
        !statsigChunkRetried
      ) {
        // The cached statsig middleware chunk/module is stale (Grok shipped a
        // new build). Drop the cache, rediscover from the live page and retry
        // the request once; the old source would only produce placeholder
        // statsig ids that xAI rejects as anti-bot.
        statsigChunkRetried = true;
        this.statsigChunkUrl = null;
        this.statsigModuleId = null;
        globalStatsigCache.delete(this.config.grokBaseUrl);
        try {
          await this.loadStatsigChunkSource();
        } catch (rediscoverError) {
          throw new HttpError(
            502,
            `Grok request failed: could not load statsig middleware: ${
              rediscoverError instanceof Error
                ? rediscoverError.message
                : String(rediscoverError)
            }`,
            { code: "statsig_unavailable" }
          );
        }
        payload = buildPayload();
        const page = await this.ensurePage();
        await run(page);
      } else if (
        message.includes(STATSIG_GENERATION_FAILED_MARKER) &&
        !statsigFailedRetried &&
        !message.includes("redirected to login page")
      ) {
        // Statsig generation failed on the current page. The usual cause is
        // a Grok deploy: the cached middleware chunk (or the generator the
        // page cached from it) is from an earlier build and crashes on the
        // new DOM. The old chunk still loads fine, so the chunk-stale
        // branch above never fires, and merely recreating the page would
        // reload the same stale source. Drop the cached source, rediscover
        // from the live page, recreate the page (which also drops its
        // in-page generator cache), and retry once with the fresh
        // middleware.
        statsigFailedRetried = true;
        meta = null;
        setTextBufferLimit(
          textBuffer,
          onChunk ? 0 : Number.POSITIVE_INFINITY
        );
        clearTextBuffer(textBuffer);
        const staleChunkUrl = this.statsigChunkUrl;
        const staleModuleId = this.statsigModuleId;
        this.statsigChunkUrl = null;
        this.statsigModuleId = null;
        globalStatsigCache.delete(this.config.grokBaseUrl);
        try {
          await this.loadStatsigChunkSource();
        } catch (rediscoverError) {
          // Rediscovery failed (page wedged or chunks not yet loaded).
          // Retry with the previous source; the failure may have been page
          // state rather than staleness.
          this.statsigChunkUrl = staleChunkUrl;
          this.statsigModuleId = staleModuleId;
        }
        payload = buildPayload();
        let page;
        try {
          page = await this.recreatePage();
        } catch (recreateErr) {
          const recMsg = recreateErr instanceof Error ? recreateErr.message : String(recreateErr);
          if (isRecoverableContextError(recMsg)) {
            page = await this.recreateContext();
          } else {
            throw recreateErr;
          }
        }
        await run(page);
      } else if (
        message.includes("produced no response within") &&
        !ttfbRetried
      ) {
        // The page dispatched the fetch but response headers never arrived:
        // the page is wedged (stale SPA, dead network path). Recreate the
        // page and retry once before falling back to other accounts.
        ttfbRetried = true;
        meta = null;
        setTextBufferLimit(
          textBuffer,
          onChunk ? 0 : Number.POSITIVE_INFINITY
        );
        clearTextBuffer(textBuffer);
        let page;
        try {
          page = await this.recreatePage();
        } catch (recreateErr) {
          const recMsg = recreateErr instanceof Error ? recreateErr.message : String(recreateErr);
          if (isRecoverableContextError(recMsg)) {
            page = await this.recreateContext();
          } else {
            throw recreateErr;
          }
        }
        await run(page);
      } else {
        if (message.toLowerCase().includes("failed to fetch")) {
          await this.validatePage(await this.ensurePage()).catch(() => {});
        }
        throw error;
      }
    }

    const totalMs = Date.now() - requestStartedAt;
    console.log(
      `[grok-request] ${label} ${method} ${url.replace(this.config.grokBaseUrl ?? "https://grok.com", "")} ` +
        `status=${meta?.status ?? "ERR"} total=${totalMs}ms ` +
        `init=${statsigLoadedAt ? statsigLoadedAt - requestStartedAt : "?"}ms ` +
        `page=${pageReadyAt ? pageReadyAt - requestStartedAt : "?"}ms ` +
        `ttfb=${firstByteAt ? firstByteAt - pageReadyAt : "?"}ms ` +
        `first-chunk=${firstByteAt ? firstByteAt - requestStartedAt : "?"}ms`
    );

    return {
      meta,
      text: textBuffer.chunks.join("")
    };
  }

  async fetchAsset(url) {
    await this.init();

    const requestContext = this.context?.request;
    if (requestContext && typeof requestContext.get === "function") {
      const response = await requestContext.get(url, {
        failOnStatusCode: false,
        headers: {
          referer: `${this.config.grokBaseUrl}/`
        }
      });
      const status = getResponseStatus(response);
      if (!status) {
        throw new Error("Asset fetch failed without a response");
      }

      if (status >= 400) {
        throw new Error(`Asset fetch failed with status ${status}`);
      }

      const headers = getResponseHeaders(response);
      const bytes = await getResponseBody(response);
      await response.dispose?.().catch(() => {});

      return {
        contentType:
          headers["content-type"] ||
          headers["Content-Type"] ||
          "application/octet-stream",
        bytes
      };
    }

    const page = await this.context?.newPage();
    if (!page) {
      throw new Error("Asset fetch failed because no browser context is available");
    }
    const navigationResponses = [];
    const captureResponse = (response) => {
      if (isPrimaryNavigationResponse(page, response)) {
        navigationResponses.push(response);
      }
    };

    page.on("response", captureResponse);

    try {
      const initialResponse = await page.goto(url, {
        waitUntil: "commit"
      });

      try {
        await page.waitForLoadState("networkidle", {
          timeout: 5000
        });
      } catch {
        // Some asset hosts never fully settle; use the latest navigation response we saw.
      }

      const response = navigationResponses.at(-1) ?? initialResponse;
      const status = getResponseStatus(response);
      if (!status) {
        throw new Error("Asset fetch failed without a response");
      }

      if (status >= 400) {
        throw new Error(`Asset fetch failed with status ${status}`);
      }

      const bytes = await getResponseBody(response);
      const headers = getResponseHeaders(response);

      return {
        contentType:
          headers["content-type"] ||
          headers["Content-Type"] ||
          "application/octet-stream",
        bytes
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async fetchBase64(url) {
    const asset = await this.fetchAsset(url);

    return {
      contentType: asset.contentType,
      base64: asset.bytes.toString("base64")
    };
  }

  async close() {
    if (this.closePromise) {
      return this.closePromise;
    }

    const closePromise = (async () => {
      const initPromise = this.initPromise;
      if (initPromise) {
        await initPromise.catch(() => {});
      }

      const context = this.context;
      try {
        await context?.close();
      } finally {
        const closeError = new Error("Browser session closed");
        for (const pending of this.pending.values()) {
          pending.reject(closeError);
        }
        this.pending.clear();
        this.resetContextState();
      }
    })();

    this.closePromise = closePromise;
    try {
      await closePromise;
    } finally {
      if (this.closePromise === closePromise) {
        this.closePromise = null;
      }
    }
  }
}
