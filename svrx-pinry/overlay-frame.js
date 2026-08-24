(function exposeOverlayFrame(root, factory) {
  const api = factory(root);
  root.PinryOverlayFrame = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.startOverlayFrame(root);
}(globalThis, function buildOverlayFrameApi(root) {
  'use strict';

  const CLAIM_TIMEOUT_MS = 20000;
  const MAX_PENDING_REQUESTS = 8;
  const MAX_CANDIDATES = 500;
  const MAX_CANDIDATE_BYTES = 800 * 1024;
  const MAX_ENVELOPE_BYTES = 1024 * 1024;
  const MAX_URL_BYTES = 16 * 1024;
  const MAX_STRING_BYTES = 64 * 1024;
  const MAX_TAG_BYTES = 4 * 1024;
  const MAX_DIMENSION = 1000000;
  const RECONNECT_DELAYS = Object.freeze([500, 1000, 2000, 4000, 6000]);
  const PUBLIC_ERROR_CODES = new Set([
    'alarm_api_unavailable', 'alarm_schedule_failed', 'candidate_collection_failed',
    'candidate_payload_too_large', 'host_permission_required', 'invalid_batch_id',
    'invalid_board_request', 'invalid_candidate_url', 'invalid_job_metadata',
    'invalid_sender', 'invalid_server_configuration', 'invalid_server_response',
    'job_already_exists', 'job_discarded', 'job_id_unavailable', 'job_not_found',
    'job_not_retryable', 'job_scan_limit_exceeded', 'job_too_large', 'network_error',
    'no_candidates', 'overlay_connection_lost', 'overlay_initialization_failed',
    'overlay_integrity_failed', 'overlay_protocol_error', 'overlay_session_expired',
    'overlay_session_limit', 'overlay_session_replaced', 'pending_storage_failed',
    'server_configuration_changed', 'server_not_configured', 'stale_job_revision',
    'storage_write_failed', 'temporary_server_error', 'too_many_candidates',
    'unexpected_error', 'webextension_api_error', 'worker_interrupted',
  ]);
  const RETRYABLE_BOOTSTRAP_CODES = new Set([
    'network_error', 'host_permission_required', 'webextension_api_error',
    'overlay_connection_lost',
  ]);
  const JOB_STATES = new Set(['running', 'paused', 'completed']);
  const ITEM_STATUSES = new Set([
    'pending', 'created', 'replayed', 'failed', 'conflict', 'unknown',
  ]);
  const PAUSED_REASONS = new Set([
    'alarm_schedule_failed', 'discard_requested', 'host_permission_required',
    'invalid_server_response', 'retry_exhausted', 'server_configuration_changed',
  ]);
  const ITEM_ERROR_CODES = new Set([
    'batch_deadline_exceeded', 'in_progress', 'idempotency_mismatch',
    'pin_permanently_deleted', 'lease_lost', 'board_access_changed', 'database_busy',
    'internal_error', 'unsupported_http_stack', 'invalid_url_policy', 'blocked_address',
    'dns_rebinding_detected', 'too_many_redirects', 'image_download_failed',
    'image_fetch_timeout', 'unsupported_content_encoding', 'image_too_large',
    'image_too_many_pixels', 'invalid_image_content', 'unsupported_image_format',
    'image_processing_timeout', 'media_path_conflict', 'image_processing_failed',
    'media_configuration_error', 'media_publish_changed', 'media_storage_failed',
    'media_storage_unsupported', 'worker_interrupted', 'network_error',
    'temporary_server_error', 'invalid_server_response', 'server_configuration_changed',
    'host_permission_required',
  ]);
  const FATAL_CODES = new Set([
    'overlay_connection_lost', 'overlay_initialization_failed',
    'overlay_integrity_failed', 'overlay_protocol_error', 'overlay_session_expired',
    'overlay_session_limit', 'overlay_session_replaced',
  ]);

  function exactKeys(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const actual = Reflect.ownKeys(descriptors);
      if (actual.some((key) => typeof key !== 'string')) return false;
      actual.sort();
      const expected = [...keys].sort();
      return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]
          && descriptors[key].enumerable === true
          && Object.hasOwn(descriptors[key], 'value'));
    } catch (_error) {
      return false;
    }
  }

  function dataValue(value, key) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    try {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && descriptor.enumerable === true
        && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch (_error) {
      return undefined;
    }
  }

  function protocolError() {
    throw new Error('overlay_protocol_error');
  }

  function positiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function utf8Length(value, Encoder) {
    try {
      return new Encoder().encode(value).byteLength;
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  }

  function fitsJson(value, maximum, Encoder) {
    try {
      const serialized = JSON.stringify(value);
      return typeof serialized === 'string' && utf8Length(serialized, Encoder) <= maximum;
    } catch (_error) {
      return false;
    }
  }

  function mapPlainArray(value, maximum, mapper) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) protocolError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length && descriptors.length.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) protocolError();
    const expected = ['length', ...Array.from({ length }, (_, index) => String(index))];
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string') || keys.length !== expected.length
      || expected.some((key) => !Object.hasOwn(descriptors, key))) protocolError();
    const copy = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) protocolError();
      copy.push(mapper(descriptor.value));
    }
    return Object.freeze(copy);
  }

  function canonicalHttpUrl(value, Encoder, maximum = MAX_URL_BYTES, allowHash = false) {
    if (typeof value !== 'string' || utf8Length(value, Encoder) > maximum) return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.origin !== 'null' && parsed.username === '' && parsed.password === ''
        && (allowHash || parsed.hash === '') && parsed.href === value;
    } catch (_error) {
      return false;
    }
  }

  function canonicalServerOrigin(value, Encoder) {
    if (typeof value !== 'string' || utf8Length(value, Encoder) > MAX_URL_BYTES) return false;
    try {
      const parsed = new URL(value);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.origin !== 'null' && parsed.username === '' && parsed.password === ''
        && parsed.origin === value && parsed.pathname === '/'
        && parsed.search === '' && parsed.hash === '';
    } catch (_error) {
      return false;
    }
  }

  function protocolId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  }

  function validatePageDefaults(value, Encoder) {
    if (!exactKeys(value, ['description', 'referer'])
      || typeof value.description !== 'string'
      || utf8Length(value.description, Encoder) > MAX_STRING_BYTES
      || typeof value.referer !== 'string'
      || value.referer !== ''
        && !canonicalHttpUrl(value.referer, Encoder, MAX_STRING_BYTES, true)) protocolError();
    return Object.freeze({ description: value.description, referer: value.referer });
  }

  function validateCandidateState(value, Encoder) {
    const status = dataValue(value, 'status');
    let normalized;
    if (status === 'pending') {
      if (!exactKeys(value, ['status'])) protocolError();
      normalized = Object.freeze({ status });
    } else if (status === 'error') {
      if (!exactKeys(value, ['status', 'code'])
        || value.code !== 'candidate_collection_failed'
          && value.code !== 'candidate_payload_too_large') protocolError();
      normalized = Object.freeze({ status, code: value.code });
    } else if (status === 'result') {
      if (!exactKeys(value, ['status', 'result'])
        || !exactKeys(value.result, ['candidates', 'totalCandidates', 'truncated'])) {
        protocolError();
      }
      const seenIds = new Set();
      const seenUrls = new Set();
      const candidates = mapPlainArray(value.result.candidates, MAX_CANDIDATES, (item) => {
        if (!exactKeys(item, ['id', 'url', 'sourceType', 'width', 'height'])
          || !canonicalHttpUrl(item.url, Encoder)
          || item.id !== `pinry-candidate:${item.url}`
          || item.sourceType !== 'img' && item.sourceType !== 'background'
          || !positiveInteger(item.width) || item.width > MAX_DIMENSION
          || !positiveInteger(item.height) || item.height > MAX_DIMENSION
          || seenIds.has(item.id) || seenUrls.has(item.url)) protocolError();
        seenIds.add(item.id);
        seenUrls.add(item.url);
        return Object.freeze({
          id: item.id, url: item.url, sourceType: item.sourceType,
          width: item.width, height: item.height,
        });
      });
      if (!Number.isSafeInteger(value.result.totalCandidates)
        || value.result.totalCandidates < candidates.length
        || typeof value.result.truncated !== 'boolean'
        || value.result.truncated !== (value.result.totalCandidates > candidates.length)) {
        protocolError();
      }
      normalized = Object.freeze({
        status,
        result: Object.freeze({
          candidates,
          totalCandidates: value.result.totalCandidates,
          truncated: value.result.truncated,
        }),
      });
    } else {
      protocolError();
    }
    if (!fitsJson(normalized, MAX_CANDIDATE_BYTES, Encoder)) protocolError();
    return normalized;
  }

  function validateExpectedServer(value, Encoder) {
    if (!exactKeys(value, ['origin', 'username'])
      || !canonicalServerOrigin(value.origin, Encoder)
      || typeof value.username !== 'string' || value.username === ''
      || utf8Length(value.username, Encoder) > MAX_TAG_BYTES) protocolError();
    return Object.freeze({ origin: value.origin, username: value.username });
  }

  function validateMetadata(value, Encoder) {
    if (!exactKeys(value, ['board_ids', 'tags', 'private', 'referer', 'description'])
      || typeof value.private !== 'boolean'
      || typeof value.referer !== 'string'
      || utf8Length(value.referer, Encoder) > MAX_STRING_BYTES
      || typeof value.description !== 'string'
      || utf8Length(value.description, Encoder) > MAX_STRING_BYTES) protocolError();
    return Object.freeze({
      board_ids: mapPlainArray(value.board_ids, MAX_CANDIDATES, (boardId) => {
        if (!positiveInteger(boardId)) protocolError();
        return boardId;
      }),
      tags: mapPlainArray(value.tags, MAX_CANDIDATES, (tag) => {
        if (typeof tag !== 'string' || utf8Length(tag, Encoder) > MAX_TAG_BYTES) {
          protocolError();
        }
        return tag;
      }),
      private: value.private,
      referer: value.referer,
      description: value.description,
    });
  }

  function validateRequest(value, Encoder) {
    const type = dataValue(value, 'type');
    let normalized;
    if (type === 'pinry:get-bootstrap' || type === 'pinry:open-options') {
      if (!exactKeys(value, ['type'])) protocolError();
      normalized = Object.freeze({ type });
    } else if (type === 'pinry:create-board') {
      if (!exactKeys(value, ['type', 'name', 'private', 'expected_server'])
        || typeof value.name !== 'string' || typeof value.private !== 'boolean') protocolError();
      const name = value.name.trim();
      if (name.length < 1 || name.length > 128) protocolError();
      normalized = Object.freeze({
        type, name, private: value.private,
        expected_server: validateExpectedServer(value.expected_server, Encoder),
      });
    } else if (type === 'pinry:create-job') {
      if (!exactKeys(value, ['type', 'candidates', 'metadata', 'expected_server'])) {
        protocolError();
      }
      normalized = Object.freeze({
        type,
        candidates: mapPlainArray(value.candidates, MAX_CANDIDATES, (item) => {
          if (!exactKeys(item, ['url']) || !canonicalHttpUrl(item.url, Encoder)) {
            protocolError();
          }
          return Object.freeze({ url: item.url });
        }),
        metadata: validateMetadata(value.metadata, Encoder),
        expected_server: validateExpectedServer(value.expected_server, Encoder),
      });
    } else if (type === 'pinry:get-job' || type === 'pinry:retry-job'
      || type === 'pinry:discard-job') {
      if (!exactKeys(value, ['type', 'batch_id']) || !protocolId(value.batch_id)) {
        protocolError();
      }
      normalized = Object.freeze({ type, batch_id: value.batch_id });
    } else {
      protocolError();
    }
    if (!fitsJson(normalized, MAX_ENVELOPE_BYTES, Encoder)) protocolError();
    return normalized;
  }

  function validItemErrorCode(value) {
    return typeof value === 'string' && (ITEM_ERROR_CODES.has(value)
      || /^http_4[0-9]{2}$/.test(value) && value !== 'http_429');
  }

  function validateItem(value, includeRetryable) {
    const keys = includeRetryable ? ['status', 'retryable', 'error'] : ['status', 'error'];
    if (!exactKeys(value, keys) || !ITEM_STATUSES.has(value.status)
      || includeRetryable && typeof value.retryable !== 'boolean') protocolError();
    let error = null;
    if (value.error !== null) {
      if (!exactKeys(value.error, ['code']) || !validItemErrorCode(value.error.code)) {
        protocolError();
      }
      error = Object.freeze({ code: value.error.code });
    }
    const item = { status: value.status };
    if (includeRetryable) item.retryable = value.retryable;
    item.error = error;
    return Object.freeze(item);
  }

  function validateBootstrapJob(value) {
    if (value === null) return null;
    if (!exactKeys(value, [
      'batch_id', 'job_state', 'paused_reason', 'revision', 'updated_at', 'items',
    ]) || !protocolId(value.batch_id) || !JOB_STATES.has(value.job_state)
      || value.paused_reason !== null && !PAUSED_REASONS.has(value.paused_reason)
        && !(typeof value.paused_reason === 'string'
          && /^http_4[0-9]{2}$/.test(value.paused_reason)
          && value.paused_reason !== 'http_429')
      || !positiveInteger(value.revision)
      || !Number.isFinite(value.updated_at) || value.updated_at < 0) protocolError();
    return Object.freeze({
      batch_id: value.batch_id,
      job_state: value.job_state,
      paused_reason: value.paused_reason,
      revision: value.revision,
      updated_at: value.updated_at,
      items: mapPlainArray(value.items, MAX_CANDIDATES, (item) => validateItem(item, false)),
    });
  }

  function validateBootstrap(value, Encoder) {
    if (!exactKeys(value, [
      'configured', 'origin', 'username', 'hasPermission', 'boards', 'tags', 'current_job',
    ]) || typeof value.configured !== 'boolean' || typeof value.hasPermission !== 'boolean') {
      protocolError();
    }
    if (!value.configured) {
      if (value.origin !== null || value.username !== null || value.hasPermission) protocolError();
    } else if (!canonicalServerOrigin(value.origin, Encoder)
      || typeof value.username !== 'string' || value.username === ''
      || utf8Length(value.username, Encoder) > MAX_TAG_BYTES) protocolError();
    const boards = mapPlainArray(value.boards, 5000, (board) => {
      if (!exactKeys(board, ['id', 'name']) || !positiveInteger(board.id)
        || typeof board.name !== 'string'
        || utf8Length(board.name, Encoder) > MAX_TAG_BYTES) protocolError();
      return Object.freeze({ id: board.id, name: board.name });
    });
    const tags = mapPlainArray(value.tags, 5000, (tag) => {
      if (typeof tag !== 'string' || utf8Length(tag, Encoder) > MAX_TAG_BYTES) protocolError();
      return tag;
    });
    if ((!value.configured || !value.hasPermission) && (boards.length || tags.length)) {
      protocolError();
    }
    return Object.freeze({
      configured: value.configured,
      origin: value.origin,
      username: value.username,
      hasPermission: value.hasPermission,
      boards,
      tags,
      current_job: validateBootstrapJob(value.current_job),
    });
  }

  function validateJob(value, Encoder) {
    if (!exactKeys(value, [
      'batch_id', 'job_state', 'items', 'server_origin', 'server_username',
    ]) || !protocolId(value.batch_id) || !JOB_STATES.has(value.job_state)
      || !canonicalServerOrigin(value.server_origin, Encoder)
      || typeof value.server_username !== 'string' || value.server_username === ''
      || utf8Length(value.server_username, Encoder) > MAX_TAG_BYTES) protocolError();
    return Object.freeze({
      batch_id: value.batch_id,
      job_state: value.job_state,
      items: mapPlainArray(value.items, MAX_CANDIDATES, (item) => validateItem(item, true)),
      server_origin: value.server_origin,
      server_username: value.server_username,
    });
  }

  function validateResponse(requestType, value, Encoder) {
    if (exactKeys(value, ['ok', 'code']) && value.ok === false
      && value.code === 'invalid_server_response') {
      return Object.freeze({ ok: false, code: value.code });
    }
    if (requestType === 'pinry:get-bootstrap') {
      if (exactKeys(value, ['ok', 'code', 'retryable']) && value.ok === false
        && PUBLIC_ERROR_CODES.has(value.code) && typeof value.retryable === 'boolean'
        && value.retryable === RETRYABLE_BOOTSTRAP_CODES.has(value.code)) {
        return Object.freeze({ ok: false, code: value.code, retryable: value.retryable });
      }
      if (exactKeys(value, ['ok', 'bootstrap']) && value.ok === true) {
        return Object.freeze({ ok: true, bootstrap: validateBootstrap(value.bootstrap, Encoder) });
      }
      protocolError();
    }
    if (exactKeys(value, ['ok', 'code']) && value.ok === false
      && PUBLIC_ERROR_CODES.has(value.code)) return Object.freeze({ ok: false, code: value.code });
    if (requestType === 'pinry:create-board'
      && exactKeys(value, ['ok', 'id', 'name']) && value.ok === true
      && positiveInteger(value.id) && typeof value.name === 'string'
      && utf8Length(value.name, Encoder) <= MAX_TAG_BYTES) {
      return Object.freeze({ ok: true, id: value.id, name: value.name });
    }
    if (requestType === 'pinry:create-job'
      && exactKeys(value, ['ok', 'batch_id']) && value.ok === true
      && protocolId(value.batch_id)) {
      return Object.freeze({ ok: true, batch_id: value.batch_id });
    }
    if (requestType === 'pinry:get-job'
      && exactKeys(value, ['ok', 'job']) && value.ok === true) {
      return Object.freeze({ ok: true, job: validateJob(value.job, Encoder) });
    }
    if ((requestType === 'pinry:retry-job' || requestType === 'pinry:open-options')
      && exactKeys(value, ['ok']) && value.ok === true) return Object.freeze({ ok: true });
    if (requestType === 'pinry:discard-job' && value && value.ok === true) {
      if (exactKeys(value, ['ok'])) return Object.freeze({ ok: true });
      if (exactKeys(value, ['ok', 'cleanup_pending'])
        && typeof value.cleanup_pending === 'boolean') {
        return Object.freeze({ ok: true, cleanup_pending: value.cleanup_pending });
      }
    }
    protocolError();
  }

  function validateGenericResponse(value, Encoder) {
    for (const type of [
      'pinry:get-bootstrap', 'pinry:create-board', 'pinry:create-job',
      'pinry:get-job', 'pinry:retry-job', 'pinry:discard-job', 'pinry:open-options',
    ]) {
      try { return validateResponse(type, value, Encoder); } catch (_error) { /* next */ }
    }
    protocolError();
  }

  function initialCapability(locationObject) {
    if (!locationObject || locationObject.pathname !== '/overlay.html'
      || locationObject.search !== '' || !/^#[0-9a-f]{64}$/.test(locationObject.hash)) {
      return null;
    }
    return locationObject.hash.slice(1);
  }

  function startOverlayFrame(scope, options = {}) {
    if (!scope || typeof scope !== 'object') return null;
    const capability = initialCapability(options.location || scope.location);
    if (!capability) return null;
    const runtime = options.runtime || (scope.chrome && scope.chrome.runtime);
    const documentObject = options.document || scope.document;
    const historyObject = options.history || scope.history;
    const rendererApi = options.rendererApi || scope.PinryBookmarklet;
    const selectionApi = options.selectionApi || scope.PinrySelection;
    const setTimeoutImpl = options.setTimeoutImpl
      || (typeof scope.setTimeout === 'function' && scope.setTimeout.bind(scope));
    const clearTimeoutImpl = options.clearTimeoutImpl
      || (typeof scope.clearTimeout === 'function' && scope.clearTimeout.bind(scope));
    const now = options.now || Date.now;
    const Encoder = scope.TextEncoder || root.TextEncoder;
    if (!runtime || typeof runtime.connect !== 'function' || !documentObject
      || !documentObject.body || !historyObject || typeof historyObject.replaceState !== 'function'
      || !rendererApi || typeof rendererApi.openOverlay !== 'function'
      || !selectionApi || typeof setTimeoutImpl !== 'function'
      || typeof clearTimeoutImpl !== 'function' || typeof now !== 'function'
      || typeof Encoder !== 'function') return null;

    let phase = 'CLAIMING';
    let port = null;
    let generation = 0;
    let claimedEpoch = null;
    let connectionEpoch = null;
    let requestCounter = 0;
    let retryCount = 0;
    let renderer = null;
    let claimTimer = null;
    let retryTimer = null;
    let recoveryTimer = null;
    let closeId = null;
    let pageDefaults = null;
    let candidateSettled = false;
    let candidateValue = null;
    let candidateResolve;
    let candidateReject;
    const pendingRequests = new Map();
    const transportListeners = new Set();
    const intentionalDisconnects = new WeakSet();
    const eventBindings = [];
    const candidatePromise = new Promise((resolve, reject) => {
      candidateResolve = resolve;
      candidateReject = reject;
    });

    function responseError(type, code) {
      return type === 'pinry:get-bootstrap'
        ? { ok: false, code, retryable: code === 'overlay_connection_lost' }
        : { ok: false, code };
    }

    function emitTransport(event) {
      for (const listener of [...transportListeners]) {
        try { listener(event); } catch (_error) { /* renderer listener와 격리한다. */ }
      }
    }

    function settlePending(code) {
      for (const record of pendingRequests.values()) {
        record.resolve(responseError(record.type, code));
      }
      pendingRequests.clear();
    }

    function disconnectBestEffort(targetPort) {
      if (!targetPort || typeof targetPort.disconnect !== 'function') return;
      try { targetPort.disconnect(); } catch (_error) { /* Port 종료는 best effort다. */ }
    }

    function disconnectIntentionally(targetPort) {
      if (!targetPort) return;
      intentionalDisconnects.add(targetPort);
      disconnectBestEffort(targetPort);
    }

    function clearClaimTimer() {
      if (claimTimer !== null) clearTimeoutImpl(claimTimer);
      claimTimer = null;
    }

    function clearTimer(timer) {
      if (timer !== null) clearTimeoutImpl(timer);
      return null;
    }

    function unbindEvents() {
      for (const [target, type, listener] of eventBindings) {
        try { target.removeEventListener(type, listener); } catch (_error) { /* best effort */ }
      }
      eventBindings.length = 0;
    }

    function terminal(code = 'overlay_protocol_error') {
      if (phase === 'TERMINAL') return;
      phase = 'TERMINAL';
      generation += 1;
      clearClaimTimer();
      retryTimer = clearTimer(retryTimer);
      recoveryTimer = clearTimer(recoveryTimer);
      settlePending(code);
      emitTransport({ status: 'terminal', code });
      const closingPort = port;
      port = null;
      disconnectIntentionally(closingPort);
      unbindEvents();
      if (renderer && typeof renderer.dispose === 'function') renderer.dispose();
    }

    function settleCandidate(candidateState) {
      if (candidateState.status === 'pending') {
        if (candidateSettled) terminal();
        return;
      }
      if (candidateSettled) {
        if (JSON.stringify(candidateState) !== JSON.stringify(candidateValue)) terminal();
        return;
      }
      candidateSettled = true;
      candidateValue = candidateState;
      if (candidateState.status === 'result') candidateResolve(candidateState.result);
      else candidateReject(Object.freeze({ code: candidateState.code }));
    }

    const requestTransport = Object.freeze({
      request(innerRequest) {
        let request;
        try { request = validateRequest(innerRequest, Encoder); } catch (_error) {
          return Promise.resolve({ ok: false, code: 'overlay_protocol_error' });
        }
        if (phase !== 'CONNECTED' || connectionEpoch === null || closeId !== null) {
          return Promise.resolve(responseError(request.type, 'overlay_connection_lost'));
        }
        if (pendingRequests.size >= MAX_PENDING_REQUESTS
          || requestCounter >= Number.MAX_SAFE_INTEGER) {
          return Promise.resolve({ ok: false, code: 'overlay_protocol_error' });
        }
        const requestId = requestCounter + 1;
        const envelope = {
          version: 1, kind: 'request', connection_epoch: connectionEpoch,
          request_id: requestId, request,
        };
        if (!fitsJson(envelope, MAX_ENVELOPE_BYTES, Encoder)) {
          return Promise.resolve({ ok: false, code: 'overlay_protocol_error' });
        }
        return new Promise((resolve) => {
          const record = { type: request.type, resolve };
          pendingRequests.set(requestId, record);
          try {
            port.postMessage(envelope);
            requestCounter = requestId;
          } catch (_error) {
            if (pendingRequests.get(requestId) === record) pendingRequests.delete(requestId);
            record.resolve(responseError(record.type, 'overlay_connection_lost'));
            scheduleReconnect(port);
          }
        });
      },
      subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        transportListeners.add(listener);
        listener(phase === 'CONNECTED'
          ? { status: 'connected' }
          : phase === 'TERMINAL'
            ? { status: 'terminal', code: 'overlay_protocol_error' }
            : { status: 'reconnecting' });
        return () => transportListeners.delete(listener);
      },
    });

    function beginClose() {
      if (phase === 'TERMINAL' || closeId !== null) return;
      closeId = 1;
      settlePending('overlay_connection_lost');
      if (phase === 'CONNECTED') sendClose();
    }

    function sendClose() {
      if (!port || connectionEpoch === null || closeId === null) return;
      try {
        port.postMessage({
          version: 1,
          kind: 'close',
          connection_epoch: connectionEpoch,
          close_id: closeId,
        });
      } catch (_error) {
        scheduleReconnect(port);
      }
    }

    function renderFrame(state) {
      try {
        historyObject.replaceState(null, '', '/overlay.html');
        phase = 'CONNECTED';
        renderer = rendererApi.openOverlay(scope, {
          document: documentObject,
          mountRoot: documentObject.body,
          requestTransport,
          candidatePromise,
          selectionApi,
          pageDefaults: state.pageDefaults,
          onClose: beginClose,
          setTimeoutImpl,
          clearTimeoutImpl,
          pollIntervalMs: options.pollIntervalMs,
        });
        pageDefaults = state.pageDefaults;
        settleCandidate(state.candidateState);
      } catch (_error) {
        terminal('overlay_initialization_failed');
      }
    }

    function validateSessionState(message) {
      if (!exactKeys(message, [
        'version', 'kind', 'connection_epoch', 'page_defaults', 'candidate_state',
      ]) || message.version !== 1 || message.kind !== 'session-state'
        || !positiveInteger(message.connection_epoch)) protocolError();
      const state = Object.freeze({
        pageDefaults: validatePageDefaults(message.page_defaults, Encoder),
        candidateState: validateCandidateState(message.candidate_state, Encoder),
      });
      if (!fitsJson({
        version: 1, kind: 'session-state', connection_epoch: message.connection_epoch,
        page_defaults: state.pageDefaults, candidate_state: state.candidateState,
      }, MAX_ENVELOPE_BYTES, Encoder)) protocolError();
      return state;
    }

    function handleConnectedMessage(message) {
      const messageEpoch = dataValue(message, 'connection_epoch');
      if (positiveInteger(messageEpoch) && messageEpoch !== connectionEpoch) return;
      const kind = dataValue(message, 'kind');
      if (kind === 'session-state') {
        let state;
        try { state = validateSessionState(message); } catch (_error) { terminal(); return; }
        if (JSON.stringify(state.pageDefaults) !== JSON.stringify(pageDefaults)) {
          terminal();
          return;
        }
        settleCandidate(state.candidateState);
        return;
      }
      if (kind === 'focus') {
        if (!exactKeys(message, ['version', 'kind', 'connection_epoch'])
          || message.version !== 1 || messageEpoch !== connectionEpoch) {
          terminal();
          return;
        }
        if (renderer && typeof renderer.focus === 'function') renderer.focus();
        return;
      }
      if (kind === 'response') {
        if (!exactKeys(message, [
          'version', 'kind', 'connection_epoch', 'request_id', 'response',
        ]) || message.version !== 1 || messageEpoch !== connectionEpoch
          || !positiveInteger(message.request_id)) {
          terminal();
          return;
        }
        const record = pendingRequests.get(message.request_id);
        let response;
        try {
          response = record
            ? validateResponse(record.type, message.response, Encoder)
            : validateGenericResponse(message.response, Encoder);
          if (!fitsJson({
            version: 1, kind: 'response', connection_epoch: connectionEpoch,
            request_id: message.request_id, response,
          }, MAX_ENVELOPE_BYTES, Encoder)) protocolError();
        } catch (_error) {
          terminal();
          return;
        }
        if (!record) return;
        pendingRequests.delete(message.request_id);
        record.resolve(response);
        return;
      }
      if (kind === 'fatal') {
        if (!exactKeys(message, ['version', 'kind', 'connection_epoch', 'code'])
          || message.version !== 1 || messageEpoch !== connectionEpoch
          || !FATAL_CODES.has(message.code)) {
          terminal();
          return;
        }
        terminal(message.code);
        return;
      }
      if (kind === 'closing') {
        if (!exactKeys(message, ['version', 'kind', 'connection_epoch', 'close_id'])
          || message.version !== 1 || messageEpoch !== connectionEpoch
          || !positiveInteger(message.close_id) || message.close_id !== closeId) {
          terminal();
          return;
        }
        terminal('overlay_connection_lost');
        return;
      }
      terminal();
    }

    function onMessage(message, expectedPort) {
      if (phase === 'TERMINAL' || expectedPort !== port) return;
      if (phase === 'CLAIMING') {
        if (claimedEpoch === null) {
          if (!exactKeys(message, ['version', 'kind', 'connection_epoch'])
            || message.version !== 1 || message.kind !== 'claimed'
            || !positiveInteger(message.connection_epoch)) {
            terminal();
            return;
          }
          claimedEpoch = message.connection_epoch;
          return;
        }
        const messageEpoch = dataValue(message, 'connection_epoch');
        if (positiveInteger(messageEpoch) && messageEpoch !== claimedEpoch) return;
        let state;
        try { state = validateSessionState(message); } catch (_error) { terminal(); return; }
        if (renderer && JSON.stringify(state.pageDefaults) !== JSON.stringify(pageDefaults)) {
          terminal();
          return;
        }
        const previousEpoch = connectionEpoch;
        connectionEpoch = claimedEpoch;
        if (previousEpoch !== null && connectionEpoch !== previousEpoch) requestCounter = 0;
        clearClaimTimer();
        retryCount = 0;
        phase = 'CONNECTED';
        if (!renderer) renderFrame(state);
        else {
          settleCandidate(state.candidateState);
          if (closeId !== null) sendClose();
          else emitTransport({ status: 'connected' });
        }
        return;
      }
      handleConnectedMessage(message);
    }

    function scheduleReconnect(failedPort) {
      if (phase === 'TERMINAL' || phase === 'SUSPENDED') return;
      clearClaimTimer();
      if (failedPort && port === failedPort) port = null;
      disconnectIntentionally(failedPort);
      settlePending('overlay_connection_lost');
      emitTransport({ status: 'reconnecting' });
      claimedEpoch = null;
      phase = 'RECONNECTING';
      generation += 1;
      retryTimer = clearTimer(retryTimer);
      if (retryCount >= RECONNECT_DELAYS.length) {
        terminal('overlay_connection_lost');
        return;
      }
      const delay = RECONNECT_DELAYS[retryCount];
      retryCount += 1;
      const expectedGeneration = generation;
      retryTimer = setTimeoutImpl(() => {
        retryTimer = null;
        if (phase !== 'RECONNECTING' || generation !== expectedGeneration) return;
        connect();
      }, delay);
    }

    function connect() {
      if (phase === 'TERMINAL' || phase === 'SUSPENDED') return;
      generation += 1;
      const expectedGeneration = generation;
      phase = 'CLAIMING';
      claimedEpoch = null;
      let nextPort;
      try { nextPort = runtime.connect({ name: 'pinry-overlay-frame-v1' }); } catch (_error) {
        scheduleReconnect(null);
        return;
      }
      if (!nextPort || !nextPort.onMessage || !nextPort.onDisconnect
        || typeof nextPort.onMessage.addListener !== 'function'
        || typeof nextPort.onDisconnect.addListener !== 'function'
        || typeof nextPort.postMessage !== 'function') {
        disconnectIntentionally(nextPort);
        scheduleReconnect(null);
        return;
      }
      port = nextPort;
      nextPort.onMessage.addListener((message) => {
        if (expectedGeneration !== generation) return;
        onMessage(message, nextPort);
      });
      nextPort.onDisconnect.addListener(() => {
        if (intentionalDisconnects.has(nextPort)) {
          intentionalDisconnects.delete(nextPort);
          return;
        }
        if (phase === 'TERMINAL' || phase === 'SUSPENDED'
          || port !== nextPort || expectedGeneration !== generation) return;
        port = null;
        scheduleReconnect(null);
      });
      try {
        nextPort.postMessage({ version: 1, kind: 'claim', session_id: capability });
      } catch (_error) {
        port = null;
        disconnectIntentionally(nextPort);
        scheduleReconnect(null);
        return;
      }
      claimTimer = setTimeoutImpl(() => {
        claimTimer = null;
        if (phase === 'CLAIMING' && port === nextPort
          && expectedGeneration === generation) terminal();
      }, CLAIM_TIMEOUT_MS);
    }

    function suspend() {
      if (phase === 'TERMINAL') return;
      recoveryTimer = clearTimer(recoveryTimer);
      generation += 1;
      if (phase === 'SUSPENDED') return;
      phase = 'SUSPENDED';
      clearClaimTimer();
      retryTimer = clearTimer(retryTimer);
      settlePending('overlay_connection_lost');
      emitTransport({ status: 'reconnecting' });
      const suspendedPort = port;
      port = null;
      claimedEpoch = null;
      disconnectIntentionally(suspendedPort);
    }

    function recover() {
      if (phase !== 'SUSPENDED' || recoveryTimer !== null) return;
      const expectedGeneration = generation;
      recoveryTimer = setTimeoutImpl(() => {
        recoveryTimer = null;
        if (phase !== 'SUSPENDED' || generation !== expectedGeneration) return;
        phase = 'RECONNECTING';
        retryCount = 0;
        connect();
      }, 0);
    }

    function bindEvent(target, type, listener) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, listener);
      eventBindings.push([target, type, listener]);
    }

    bindEvent(scope, 'pagehide', (event) => {
      if (event && event.persisted === true) suspend();
      else terminal('overlay_connection_lost');
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
    connect();
    return Object.freeze({ isLive() { return phase !== 'TERMINAL'; } });
  }

  return Object.freeze({ startOverlayFrame });
}));
