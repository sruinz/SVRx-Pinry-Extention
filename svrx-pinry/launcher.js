(function exposeOverlayLauncher(root, factory) {
  const commonJs = typeof module === 'object' && module.exports;
  const existing = root.PinryOverlayLauncher;
  const api = commonJs || !existing || typeof existing.launchOverlay !== 'function'
    ? factory(root)
    : existing;
  root.PinryOverlayLauncher = api;
  if (commonJs) module.exports = api;
  else api.launchOverlay(root);
}(globalThis, function buildOverlayLauncherApi(root) {
  'use strict';

  const REGISTER_TIMEOUT_MS = 15000;
  const PAIR_TIMEOUT_MS = 20000;
  const AUTHORIZE_TIMEOUT_MS = 3000;
  const HARD_LIFETIME_MS = 2 * 60 * 60 * 1000;
  const MAX_STRING_BYTES = 64 * 1024;
  const MAX_CANDIDATE_BYTES = 800 * 1024;
  const RECONNECT_DELAYS = Object.freeze([250, 500, 1000, 2000, 4000]);
  const HOST_STYLE = ':host{all:initial!important;position:fixed!important;inset:0!important;display:block!important;z-index:2147483647!important}iframe{width:100vw!important;height:100vh!important;border:0!important;display:block!important}';
  const PRE_ACK_REJECTIONS = new Set([
    'overlay_session_expired',
    'overlay_session_limit',
  ]);
  const FATAL_CODES = new Set([
    'overlay_connection_lost',
    'overlay_initialization_failed',
    'overlay_integrity_failed',
    'overlay_protocol_error',
    'overlay_session_expired',
    'overlay_session_limit',
    'overlay_session_replaced',
  ]);
  const controllersByScope = new WeakMap();

  function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    let descriptors;
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch (_error) {
      return false;
    }
    const actual = Reflect.ownKeys(descriptors);
    if (actual.some((key) => typeof key !== 'string')) return false;
    actual.sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
      && actual.every((key, index) => key === expected[index]
        && descriptors[key].enumerable === true
        && Object.hasOwn(descriptors[key], 'value'));
  }

  function safePositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function createCapability(cryptoObject) {
    if (!cryptoObject || typeof cryptoObject.getRandomValues !== 'function') return null;
    const bytes = new Uint8Array(32);
    try {
      cryptoObject.getRandomValues(bytes);
    } catch (_error) {
      return null;
    }
    return Array.from(
      bytes,
      (value) => value.toString(16).padStart(2, '0'),
    ).join('');
  }

  function utf8Length(value, Encoder) {
    try {
      return new Encoder().encode(value).byteLength;
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  }

  function truncateUtf8(value, maximumBytes, Encoder) {
    const encoder = new Encoder();
    if (encoder.encode(value).byteLength <= maximumBytes) return value;
    let output = '';
    let byteLength = 0;
    for (const character of value) {
      const characterBytes = encoder.encode(character).byteLength;
      if (byteLength + characterBytes > maximumBytes) break;
      output += character;
      byteLength += characterBytes;
    }
    return output;
  }

  function canonicalTopDocumentUrl(rawUrl, Encoder) {
    if (typeof rawUrl !== 'string' || utf8Length(rawUrl, Encoder) > MAX_STRING_BYTES) {
      return '';
    }
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (_error) {
      return '';
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.origin === 'null' || parsed.username || parsed.password
      || utf8Length(parsed.href, Encoder) > MAX_STRING_BYTES) return '';
    return parsed.href;
  }

  function collectPageDefaults(documentObject, Encoder) {
    let title = '';
    let href = '';
    try {
      title = String(documentObject.title || '');
      href = documentObject.location && documentObject.location.href;
    } catch (_error) {
      // 페이지 기본값을 읽을 수 없으면 안전한 빈 값으로 등록한다.
    }
    return Object.freeze({
      description: truncateUtf8(title, MAX_STRING_BYTES, Encoder),
      referer: canonicalTopDocumentUrl(href, Encoder),
    });
  }

  function projectCandidateResult(result) {
    if (!exactKeys(result, ['candidates', 'totalCandidates', 'truncated'])
      || !Array.isArray(result.candidates)
      || !Number.isSafeInteger(result.totalCandidates)
      || result.totalCandidates < result.candidates.length
      || typeof result.truncated !== 'boolean'
      || result.truncated !== (result.totalCandidates > result.candidates.length)) {
      return null;
    }
    const candidates = [];
    for (const candidate of result.candidates) {
      if (!exactKeys(candidate, ['id', 'url', 'sourceType', 'width', 'height'])
        || typeof candidate.id !== 'string' || typeof candidate.url !== 'string'
        || candidate.id !== `pinry-candidate:${candidate.url}`
        || candidate.sourceType !== 'img' && candidate.sourceType !== 'background'
        || !safePositiveInteger(candidate.width) || !safePositiveInteger(candidate.height)) {
        return null;
      }
      candidates.push(Object.freeze({
        id: candidate.id,
        url: candidate.url,
        sourceType: candidate.sourceType,
        width: candidate.width,
        height: candidate.height,
      }));
    }
    return Object.freeze({
      candidates: Object.freeze(candidates),
      totalCandidates: result.totalCandidates,
      truncated: result.truncated,
    });
  }

  function candidateTerminalState(result, Encoder) {
    const projected = projectCandidateResult(result);
    if (!projected) {
      return Object.freeze({ status: 'error', code: 'candidate_collection_failed' });
    }
    const state = Object.freeze({ status: 'result', result: projected });
    let serialized;
    try {
      serialized = JSON.stringify(state);
    } catch (_error) {
      return Object.freeze({ status: 'error', code: 'candidate_collection_failed' });
    }
    if (utf8Length(serialized, Encoder) > MAX_CANDIDATE_BYTES) {
      return Object.freeze({ status: 'error', code: 'candidate_payload_too_large' });
    }
    return state;
  }

  function createOverlayHost(documentObject, frameUrl) {
    const host = documentObject.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = documentObject.createElement('style');
    style.textContent = HOST_STYLE;
    const frame = documentObject.createElement('iframe');
    frame.title = 'SVRx Pinry 이미지 선택';
    frame.src = frameUrl;
    shadow.appendChild(style);
    shadow.appendChild(frame);
    documentObject.body.appendChild(host);
    return { host, shadow, style, frame };
  }

  function launchOverlay(scope, options = {}) {
    if (!scope || typeof scope !== 'object') return null;
    const duplicate = controllersByScope.get(scope);
    if (duplicate) {
      if (duplicate.isLive()) {
        duplicate.focus();
        return duplicate;
      }
      return null;
    }

    const runtime = options.runtime || (scope.chrome && scope.chrome.runtime);
    const documentObject = options.document || scope.document;
    const candidatesApi = options.candidatesApi || scope.PinryCandidates;
    const cryptoObject = Object.hasOwn(options, 'crypto') ? options.crypto : scope.crypto;
    const now = options.now || Date.now;
    const getComputedStyleImpl = options.getComputedStyle
      || (typeof scope.getComputedStyle === 'function' && scope.getComputedStyle.bind(scope));
    const setTimeoutImpl = options.setTimeoutImpl
      || (typeof scope.setTimeout === 'function' && scope.setTimeout.bind(scope));
    const clearTimeoutImpl = options.clearTimeoutImpl
      || (typeof scope.clearTimeout === 'function' && scope.clearTimeout.bind(scope));
    const Encoder = scope.TextEncoder || root.TextEncoder;
    const capability = createCapability(cryptoObject);
    if (!capability) return null;
    if (!runtime || typeof runtime.connect !== 'function'
      || typeof runtime.getURL !== 'function'
      || !documentObject || !documentObject.body
      || !candidatesApi || typeof candidatesApi.collectCandidateResult !== 'function'
      || typeof candidatesApi.createImageProbe !== 'function'
      || typeof now !== 'function' || typeof getComputedStyleImpl !== 'function'
      || typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function'
      || typeof Encoder !== 'function') return null;

    const issuedAt = now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) return null;
    const pageDefaults = collectPageDefaults(documentObject, Encoder);
    const hardDeadline = issuedAt + HARD_LIFETIME_MS;
    const preparedAt = now();
    if (!Number.isSafeInteger(hardDeadline) || !Number.isSafeInteger(preparedAt)
      || preparedAt < 0 || preparedAt >= hardDeadline) return null;
    const hardLifetimeRemaining = hardDeadline - preparedAt;
    const pendingCandidateState = Object.freeze({ status: 'pending' });
    let candidateState = pendingCandidateState;
    let phase = 'REGISTERING';
    let generation = 0;
    let connectionEpoch = null;
    let port = null;
    let portCandidateState = null;
    let retryCount = 0;
    let registerTimer = null;
    let pairTimer = null;
    let retryTimer = null;
    let recoveryTimer = null;
    let hardTimer = null;
    let hostRecord = null;
    let opener = documentObject.activeElement || null;
    let collectionLive = true;
    const intentionalDisconnects = new WeakSet();
    const authorizeRequestIds = new Set();
    const eventBindings = [];

    function safePost(targetPort, message) {
      if (!targetPort || targetPort.disconnected) return false;
      try {
        targetPort.postMessage(message);
        return true;
      } catch (_error) {
        return false;
      }
    }

    function clearTimer(timer) {
      if (timer !== null) clearTimeoutImpl(timer);
      return null;
    }

    function disconnectIntentionally(targetPort) {
      if (!targetPort || typeof targetPort.disconnect !== 'function') return;
      intentionalDisconnects.add(targetPort);
      try {
        targetPort.disconnect();
      } catch (_error) {
        // Port 종료는 best effort로 완료한다.
      }
    }

    function removeHost() {
      if (!hostRecord) return true;
      let removalFailed = false;
      try {
        hostRecord.host.remove();
      } catch (_error) {
        removalFailed = true;
      }
      try {
        if (removalFailed || hostRecord.host.isConnected !== false) return false;
      } catch (_error) {
        return false;
      }
      hostRecord = null;
      return true;
    }

    function visible(element) {
      let style;
      let rect;
      try {
        style = getComputedStyleImpl(element);
        rect = element.getBoundingClientRect();
      } catch (_error) {
        return false;
      }
      const viewportWidth = Number(scope.innerWidth
        || documentObject.documentElement && documentObject.documentElement.clientWidth);
      const viewportHeight = Number(scope.innerHeight
        || documentObject.documentElement && documentObject.documentElement.clientHeight);
      const width = Number(rect.width);
      const height = Number(rect.height);
      return Boolean(style) && element.isConnected === true
        && style.display !== 'none'
        && style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && Number(style.opacity) > 0
        && style.pointerEvents !== 'none'
        && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
        && Number(rect.right) > Number(rect.left)
        && Number(rect.bottom) > Number(rect.top)
        && Number(rect.right) > 0 && Number(rect.bottom) > 0
        && Number(rect.left) < viewportWidth && Number(rect.top) < viewportHeight;
    }

    function hostIntegrity(expectedGeneration) {
      if (phase !== 'PAIRED' || expectedGeneration !== generation || !hostRecord) return false;
      const { host, shadow, style, frame } = hostRecord;
      return host.parentNode === documentObject.body
        && shadow.host === host
        && shadow.children && shadow.children[0] === style && shadow.children[1] === frame
        && frame.parentNode === shadow
        && visible(host) && visible(frame);
    }

    function dataMethod(value, key) {
      try {
        let current = value;
        while (current) {
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          if (descriptor) {
            return Object.hasOwn(descriptor, 'value')
              && typeof descriptor.value === 'function' ? descriptor.value : null;
          }
          current = Object.getPrototypeOf(current);
        }
      } catch (_error) {
        return null;
      }
      return null;
    }

    function hasBlockingState(element, key) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(element, key);
        if (descriptor && !Object.hasOwn(descriptor, 'value')) return true;
        if (descriptor && descriptor.value === true) return true;
        const hasAttribute = dataMethod(element, 'hasAttribute');
        return !hasAttribute || hasAttribute.call(element, key) === true;
      } catch (_error) {
        return true;
      }
    }

    function focusMethodFor(element) {
      if (!element || element.isConnected !== true) return null;
      for (const key of ['disabled', 'hidden', 'inert']) {
        if (hasBlockingState(element, key)) return null;
      }
      let style;
      try {
        style = getComputedStyleImpl(element);
      } catch (_error) {
        return null;
      }
      if (!style || style.display === 'none'
        || style.visibility === 'hidden' || style.visibility === 'collapse') return null;
      return dataMethod(element, 'focus');
    }

    function restoreFocus() {
      let target = opener;
      let focus = focusMethodFor(target);
      if (!focus) {
        target = documentObject.body;
        focus = dataMethod(target, 'focus');
      }
      opener = null;
      if (!target || !focus) return;
      try {
        focus.call(target);
      } catch (_error) {
        const bodyFocus = dataMethod(documentObject.body, 'focus');
        if (target !== documentObject.body && bodyFocus) {
          try { bodyFocus.call(documentObject.body); } catch (_fallbackError) { /* best effort */ }
        }
      }
    }

    function unbindEvents() {
      for (const [target, type, listener] of eventBindings) {
        try { target.removeEventListener(type, listener); } catch (_error) { /* best effort */ }
      }
      eventBindings.length = 0;
    }

    function forgetController() {
      if (controllersByScope.get(scope) === controller) controllersByScope.delete(scope);
    }

    function terminalCleanup() {
      if (phase === 'TERMINAL') return;
      phase = 'TERMINAL';
      generation += 1;
      collectionLive = false;
      registerTimer = clearTimer(registerTimer);
      pairTimer = clearTimer(pairTimer);
      retryTimer = clearTimer(retryTimer);
      recoveryTimer = clearTimer(recoveryTimer);
      hardTimer = clearTimer(hardTimer);
      const closingPort = port;
      port = null;
      connectionEpoch = null;
      const hostRemoved = removeHost();
      disconnectIntentionally(closingPort);
      unbindEvents();
      if (hostRemoved) {
        forgetController();
        restoreFocus();
      }
    }

    function abortIntegrity() {
      if (connectionEpoch !== null && port) {
        safePost(port, {
          version: 1,
          kind: 'abort',
          connection_epoch: connectionEpoch,
          code: 'overlay_integrity_failed',
        });
      }
      terminalCleanup();
    }

    function schedulePairDeadline(expectedGeneration, expectedEpoch) {
      pairTimer = clearTimer(pairTimer);
      pairTimer = setTimeoutImpl(() => {
        pairTimer = null;
        if (phase !== 'TERMINAL' && phase !== 'SUSPENDED'
          && generation === expectedGeneration && connectionEpoch === expectedEpoch) {
          terminalCleanup();
        }
      }, PAIR_TIMEOUT_MS);
    }

    function scheduleReconnect() {
      if (phase === 'TERMINAL' || phase === 'SUSPENDED') return;
      const failedPort = port;
      port = null;
      connectionEpoch = null;
      generation += 1;
      disconnectIntentionally(failedPort);
      registerTimer = clearTimer(registerTimer);
      pairTimer = clearTimer(pairTimer);
      if (retryCount >= RECONNECT_DELAYS.length) {
        terminalCleanup();
        return;
      }
      const delay = RECONNECT_DELAYS[retryCount];
      retryCount += 1;
      phase = 'REGISTERING';
      retryTimer = setTimeoutImpl(() => {
        retryTimer = null;
        if (phase === 'REGISTERING') connectLauncher();
      }, delay);
    }

    function malformedCurrentMessage() {
      if (connectionEpoch === null) terminalCleanup();
      else abortIntegrity();
    }

    function handleRegisteredMessage(message, expectedPort, expectedGeneration) {
      if (phase === 'REGISTERING') {
        if (exactKeys(message, ['version', 'kind', 'code'])
          && message.version === 1 && message.kind === 'rejected'
          && PRE_ACK_REJECTIONS.has(message.code)) {
          terminalCleanup();
          return;
        }
        if (!exactKeys(message, ['version', 'kind', 'connection_epoch'])
          || message.version !== 1 || message.kind !== 'registered'
          || !safePositiveInteger(message.connection_epoch)) {
          terminalCleanup();
          return;
        }
        registerTimer = clearTimer(registerTimer);
        connectionEpoch = message.connection_epoch;
        authorizeRequestIds.clear();
        try {
          if (!hostRecord) {
            hostRecord = createOverlayHost(
              documentObject,
              `${runtime.getURL('overlay.html')}#${capability}`,
            );
          }
        } catch (_error) {
          terminalCleanup();
          return;
        }
        phase = 'REGISTERED';
        schedulePairDeadline(expectedGeneration, connectionEpoch);
        if (candidateState !== portCandidateState) {
          if (!safePost(expectedPort, {
            version: 1,
            kind: 'state',
            connection_epoch: connectionEpoch,
            candidate_state: candidateState,
          })) scheduleReconnect();
        }
        return;
      }

      const messageEpoch = message.connection_epoch;
      if (safePositiveInteger(messageEpoch) && messageEpoch !== connectionEpoch) return;
      if (message.version !== 1 || messageEpoch !== connectionEpoch) {
        malformedCurrentMessage();
        return;
      }
      if (message.kind === 'paired'
        && exactKeys(message, ['version', 'kind', 'connection_epoch'])
        && (phase === 'REGISTERED' || phase === 'FRAME_RECONNECTING')) {
        pairTimer = clearTimer(pairTimer);
        phase = 'PAIRED';
        retryCount = 0;
        return;
      }
      if (message.kind === 'frame-reconnecting'
        && exactKeys(message, ['version', 'kind', 'connection_epoch'])
        && phase === 'PAIRED') {
        phase = 'FRAME_RECONNECTING';
        schedulePairDeadline(expectedGeneration, connectionEpoch);
        return;
      }
      if (message.kind === 'authorize'
        && exactKeys(message, ['version', 'kind', 'connection_epoch', 'request_id'])
        && safePositiveInteger(message.request_id)) {
        const startedAt = now();
        if (phase !== 'PAIRED' || authorizeRequestIds.has(message.request_id)
          || !Number.isSafeInteger(startedAt) || startedAt < 0
          || !hostIntegrity(expectedGeneration)) {
          abortIntegrity();
          return;
        }
        authorizeRequestIds.add(message.request_id);
        const finishedAt = now();
        if (!Number.isSafeInteger(finishedAt) || finishedAt - startedAt > AUTHORIZE_TIMEOUT_MS
          || !safePost(expectedPort, {
            version: 1,
            kind: 'authorize-result',
            connection_epoch: connectionEpoch,
            request_id: message.request_id,
            allowed: true,
          })) abortIntegrity();
        return;
      }
      if (message.kind === 'remove-host'
        && exactKeys(message, ['version', 'kind', 'connection_epoch', 'close_id'])
        && safePositiveInteger(message.close_id)) {
        registerTimer = clearTimer(registerTimer);
        pairTimer = clearTimer(pairTimer);
        retryTimer = clearTimer(retryTimer);
        recoveryTimer = clearTimer(recoveryTimer);
        hardTimer = clearTimer(hardTimer);
        phase = 'TERMINAL';
        generation += 1;
        collectionLive = false;
        const hostRemoved = removeHost();
        if (hostRemoved) {
          restoreFocus();
          safePost(expectedPort, {
            version: 1,
            kind: 'host-removed',
            connection_epoch: messageEpoch,
            close_id: message.close_id,
          });
        } else {
          safePost(expectedPort, {
            version: 1,
            kind: 'abort',
            connection_epoch: messageEpoch,
            code: 'overlay_integrity_failed',
          });
        }
        port = null;
        connectionEpoch = null;
        disconnectIntentionally(expectedPort);
        unbindEvents();
        if (hostRemoved) forgetController();
        return;
      }
      if (message.kind === 'fatal'
        && exactKeys(message, ['version', 'kind', 'connection_epoch', 'code'])
        && FATAL_CODES.has(message.code)) {
        terminalCleanup();
        return;
      }
      malformedCurrentMessage();
    }

    function connectLauncher() {
      if (phase === 'TERMINAL' || phase === 'SUSPENDED') return;
      generation += 1;
      const expectedGeneration = generation;
      connectionEpoch = null;
      phase = 'REGISTERING';
      let nextPort;
      try {
        nextPort = runtime.connect({ name: 'pinry-overlay-launcher-v1' });
      } catch (_error) {
        scheduleReconnect();
        return;
      }
      if (!nextPort || !nextPort.onMessage || !nextPort.onDisconnect
        || typeof nextPort.onMessage.addListener !== 'function'
        || typeof nextPort.onDisconnect.addListener !== 'function') {
        disconnectIntentionally(nextPort);
        scheduleReconnect();
        return;
      }
      port = nextPort;
      portCandidateState = candidateState;
      nextPort.onMessage.addListener((message) => {
        if (phase === 'TERMINAL' || nextPort !== port || expectedGeneration !== generation) return;
        handleRegisteredMessage(message, nextPort, expectedGeneration);
      });
      nextPort.onDisconnect.addListener(() => {
        if (intentionalDisconnects.has(nextPort)) {
          intentionalDisconnects.delete(nextPort);
          return;
        }
        if (phase === 'TERMINAL' || phase === 'SUSPENDED'
          || nextPort !== port || expectedGeneration !== generation) return;
        port = null;
        connectionEpoch = null;
        scheduleReconnect();
      });
      if (!safePost(nextPort, {
        version: 1,
        kind: 'register',
        session_id: capability,
        issued_at: issuedAt,
        page_defaults: pageDefaults,
        candidate_state: candidateState,
      })) {
        port = null;
        disconnectIntentionally(nextPort);
        scheduleReconnect();
        return;
      }
      registerTimer = clearTimer(registerTimer);
      registerTimer = setTimeoutImpl(() => {
        registerTimer = null;
        if (phase === 'REGISTERING' && port === nextPort
          && generation === expectedGeneration) terminalCleanup();
      }, REGISTER_TIMEOUT_MS);
    }

    function suspend() {
      if (phase === 'TERMINAL') return;
      recoveryTimer = clearTimer(recoveryTimer);
      generation += 1;
      if (phase === 'SUSPENDED') return;
      phase = 'SUSPENDED';
      registerTimer = clearTimer(registerTimer);
      pairTimer = clearTimer(pairTimer);
      retryTimer = clearTimer(retryTimer);
      const suspendedPort = port;
      port = null;
      connectionEpoch = null;
      disconnectIntentionally(suspendedPort);
    }

    function recover() {
      if (phase !== 'SUSPENDED' || recoveryTimer !== null) return;
      const expectedGeneration = generation;
      recoveryTimer = setTimeoutImpl(() => {
        recoveryTimer = null;
        if (phase !== 'SUSPENDED' || generation !== expectedGeneration) return;
        phase = 'REGISTERING';
        retryCount = 0;
        connectLauncher();
      }, 0);
    }

    function bindEvent(target, type, listener) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, listener);
      eventBindings.push([target, type, listener]);
    }

    const controller = Object.freeze({
      focus() {
        if (phase === 'TERMINAL') return false;
        if (!hostIntegrity(generation)) {
          abortIntegrity();
          return false;
        }
        if (!safePost(port, {
          version: 1,
          kind: 'focus',
          connection_epoch: connectionEpoch,
        })) {
          scheduleReconnect();
          return false;
        }
        return true;
      },
      close(_code) {
        if (phase === 'TERMINAL') return false;
        if (connectionEpoch !== null) {
          safePost(port, {
            version: 1,
            kind: 'close',
            connection_epoch: connectionEpoch,
          });
        }
        terminalCleanup();
        return true;
      },
      isLive() {
        return phase !== 'TERMINAL';
      },
    });

    controllersByScope.set(scope, controller);
    bindEvent(scope, 'pagehide', (event) => {
      if (event && event.persisted === true) suspend();
      else terminalCleanup();
    });
    bindEvent(scope, 'pageshow', (event) => {
      if (event && event.persisted === true) recover();
    });
    bindEvent(scope, 'freeze', suspend);
    bindEvent(scope, 'resume', recover);
    if (documentObject !== scope) {
      bindEvent(documentObject, 'freeze', suspend);
      bindEvent(documentObject, 'resume', recover);
    }

    hardTimer = setTimeoutImpl(terminalCleanup, hardLifetimeRemaining);
    connectLauncher();

    let collection;
    try {
      collection = candidatesApi.collectCandidateResult(
        documentObject,
        candidatesApi.createImageProbe(scope),
        { setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl },
      );
    } catch (_error) {
      collection = Promise.reject(_error);
    }
    Promise.resolve(collection).then(
      (result) => {
        if (!collectionLive || phase === 'TERMINAL') return;
        candidateState = candidateTerminalState(result, Encoder);
        if (connectionEpoch !== null && candidateState !== portCandidateState) {
          if (!safePost(port, {
            version: 1,
            kind: 'state',
            connection_epoch: connectionEpoch,
            candidate_state: candidateState,
          })) scheduleReconnect();
        }
      },
      () => {
        if (!collectionLive || phase === 'TERMINAL') return;
        candidateState = Object.freeze({
          status: 'error',
          code: 'candidate_collection_failed',
        });
        if (connectionEpoch !== null && candidateState !== portCandidateState) {
          if (!safePost(port, {
            version: 1,
            kind: 'state',
            connection_epoch: connectionEpoch,
            candidate_state: candidateState,
          })) scheduleReconnect();
        }
      },
    );
    return controller;
  }

  return Object.freeze({ launchOverlay });
}));
