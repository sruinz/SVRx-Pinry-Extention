(function exposeCandidates(root, factory) {
  const api = factory(root);
  root.PinryCandidates = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(globalThis, function buildCandidatesApi(root) {
  'use strict';

  const DEFAULT_MAX_CANDIDATES = 500;
  const DEFAULT_MAX_CONCURRENCY = 8;
  const DEFAULT_PROBE_TIMEOUT_MS = 3000;
  const MAX_URL_BYTES = 16 * 1024;
  const MAX_DIMENSION = 1000000;

  function candidateFailure(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function utf8Length(value) {
    if (typeof root.TextEncoder !== 'function') {
      throw candidateFailure('candidate_collection_failed');
    }
    return new root.TextEncoder().encode(value).byteLength;
  }

  function normalizeCandidateUrl(rawUrl, baseUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null;
    let url;
    try {
      url = new URL(rawUrl.trim(), baseUrl);
    } catch (_error) {
      return null;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return utf8Length(url.href) <= MAX_URL_BYTES ? url.href : null;
  }

  function backgroundUrls(value) {
    if (typeof value !== 'string' || value === '') return [];
    const urls = [];
    const pattern = /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi;
    let match = pattern.exec(value);
    while (match) {
      const rawUrl = match[2] === undefined ? match[3].trim() : match[2];
      if (rawUrl) urls.push(rawUrl);
      match = pattern.exec(value);
    }
    return urls;
  }

  function documentBaseUrl(documentObject) {
    if (documentObject.baseURI) return documentObject.baseURI;
    if (documentObject.URL) return documentObject.URL;
    return documentObject.location && documentObject.location.href;
  }

  function discoverCandidates(documentObject) {
    const baseUrl = documentBaseUrl(documentObject);
    const elements = Array.from(
      documentObject.querySelectorAll('img, [style]'),
    );
    const seen = new Set();
    const discovered = [];

    function add(rawUrl, sourceType) {
      const url = normalizeCandidateUrl(rawUrl, baseUrl);
      if (!url || seen.has(url)) return;
      seen.add(url);
      discovered.push({
        id: `pinry-candidate:${url}`,
        url,
        sourceType,
      });
    }

    for (const element of elements) {
      if (String(element.tagName).toLowerCase() === 'img') {
        add(element.currentSrc || element.src, 'img');
      }
      const backgroundImage = element.style && element.style.backgroundImage;
      for (const rawUrl of backgroundUrls(backgroundImage)) {
        add(rawUrl, 'background');
      }
    }
    return discovered;
  }

  function positiveInteger(value, fallback) {
    if (!Number.isFinite(value) || value < 1) return fallback;
    return Math.floor(value);
  }

  function probeCandidate(candidate, imageProbe, options) {
    const timeoutMs = positiveInteger(
      options.probeTimeoutMs,
      DEFAULT_PROBE_TIMEOUT_MS,
    );
    const setTimer = options.setTimeout || root.setTimeout.bind(root);
    const clearTimer = options.clearTimeout || root.clearTimeout.bind(root);
    const controller = typeof root.AbortController === 'function'
      ? new root.AbortController()
      : null;

    return new Promise((resolve) => {
      let settled = false;
      let cancelProbe = null;
      let timerId;

      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimer(timerId);
        resolve(value);
      }

      timerId = setTimer(() => {
        if (controller) controller.abort();
        if (cancelProbe) {
          try {
            cancelProbe();
          } catch (error) {
            // 취소 실패도 해당 후보의 probe 실패로만 처리한다.
          }
        }
        finish(null);
      }, timeoutMs);

      let operation;
      try {
        operation = imageProbe(candidate.url, {
          signal: controller ? controller.signal : undefined,
        });
      } catch (error) {
        finish(null);
        return;
      }

      let promise = operation;
      if (operation && typeof operation === 'object' && operation.promise) {
        promise = operation.promise;
        if (typeof operation.cancel === 'function') {
          cancelProbe = operation.cancel;
        }
      }
      Promise.resolve(promise).then(finish, () => finish(null));
    });
  }

  async function probeInOrder(candidates, imageProbe, options) {
    const maximum = positiveInteger(
      options.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY,
    );
    const results = new Array(candidates.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < candidates.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await probeCandidate(
          candidates[index],
          imageProbe,
          options,
        );
      }
    }

    const workerCount = Math.min(maximum, candidates.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    );
    return results;
  }

  function dimensions(probeResult) {
    if (!probeResult || typeof probeResult !== 'object') return null;
    const width = Number(probeResult.width ?? probeResult.naturalWidth);
    const height = Number(probeResult.height ?? probeResult.naturalHeight);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
    return { width, height };
  }

  function createImageProbe(scope) {
    return function imageProbe(url, { signal } = {}) {
      if (typeof scope.Image !== 'function') {
        return Promise.reject(new Error('image_probe_unavailable'));
      }
      return new Promise((resolve, reject) => {
        const image = new scope.Image();
        let settled = false;

        function cleanup() {
          image.onload = null;
          image.onerror = null;
          if (signal) signal.removeEventListener('abort', abort);
        }

        function succeed() {
          if (settled) return;
          settled = true;
          const result = {
            width: image.naturalWidth,
            height: image.naturalHeight,
          };
          cleanup();
          resolve(result);
        }

        function fail() {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error('image_probe_failed'));
        }

        function abort() {
          if (settled) return;
          settled = true;
          cleanup();
          image.src = '';
          reject(new Error('image_probe_aborted'));
        }

        image.onload = succeed;
        image.onerror = fail;
        if (signal) {
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
        }
        image.src = url;
      });
    };
  }

  async function collectCandidateResult(
    documentObject,
    imageProbe,
    options = {},
  ) {
    const discovered = discoverCandidates(documentObject);
    const probeResults = await probeInOrder(discovered, imageProbe, options);
    const accepted = [];

    for (let index = 0; index < discovered.length; index += 1) {
      const size = dimensions(probeResults[index]);
      if (!size || size.width <= 200 || size.height <= 200) continue;
      accepted.push({
        ...discovered[index],
        width: size.width,
        height: size.height,
      });
    }

    const maximum = Math.min(
      positiveInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES),
      DEFAULT_MAX_CANDIDATES,
    );
    return {
      candidates: accepted.slice(0, maximum),
      totalCandidates: accepted.length,
      truncated: accepted.length > maximum,
    };
  }

  async function collectCandidates(documentObject, imageProbe) {
    const result = await collectCandidateResult(documentObject, imageProbe);
    return result.candidates;
  }

  return {
    collectCandidateResult,
    collectCandidates,
    createImageProbe,
    normalizeCandidateUrl,
  };
}));
