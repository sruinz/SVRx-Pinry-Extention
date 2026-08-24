(function loadBackground(root, factory) {
  if (typeof importScripts === 'function' && !root.PinryOrigin) importScripts('origin.js');
  if (typeof importScripts === 'function' && !root.PinryJobs) importScripts('jobs.js');

  let originApi = root.PinryOrigin;
  let jobsApi = root.PinryJobs;
  if (!originApi && typeof module === 'object' && module.exports) {
    originApi = require('./origin.js');
  }
  if (!jobsApi && typeof module === 'object' && module.exports) {
    jobsApi = require('./jobs.js');
  }
  if (!originApi) throw new Error('origin_module_unavailable');
  if (!jobsApi) throw new Error('jobs_module_unavailable');

  const api = factory(root, originApi, jobsApi);
  root.PinryBackground = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.chrome) api.registerBackground(root.chrome);
}(globalThis, function buildBackgroundApi(root, originApi, jobsApi) {
  'use strict';

  const ACTIVE_KEY = 'pinry.server';
  const PENDING_KEY = 'pinry.server.pending';
  const JOB_PREFIX = 'pinry.job.';
  const STAGED_JOB_PREFIX = 'pinry.stage.';
  const RETRY_ALARM_PREFIX = 'pinry-retry:';
  const CLEANUP_ALARM = 'pinry-job-cleanup';
  const CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_CURRENT_JOB_SCAN = 1000;
  const MAX_CURRENT_JOB_SCAN_BYTES = 4 * 1024 * 1024;
  const OVERLAY_MAX_CANDIDATES = 500;
  const OVERLAY_MAX_CANDIDATE_BYTES = 800 * 1024;
  const OVERLAY_MAX_ENVELOPE_BYTES = 1024 * 1024;
  const OVERLAY_MAX_URL_BYTES = 16 * 1024;
  const OVERLAY_MAX_STRING_BYTES = 64 * 1024;
  const OVERLAY_MAX_TAG_BYTES = 4 * 1024;
  const OVERLAY_MAX_DIMENSION = 1000000;
  const OVERLAY_LAUNCHER_PORT_NAME = 'pinry-overlay-launcher-v1';
  const OVERLAY_FRAME_PORT_NAME = 'pinry-overlay-frame-v1';
  const OVERLAY_FIRST_ENVELOPE_TIMEOUT_MS = 1000;
  const OVERLAY_AUTHORIZE_TIMEOUT_MS = 3000;
  const OVERLAY_ENDPOINT_DEADLINE_MS = 20000;
  const OVERLAY_BACKGROUND_GRACE_MS = 25000;
  const OVERLAY_CLOSE_FALLBACK_MS = 2000;
  const OVERLAY_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  const OVERLAY_FUTURE_SKEW_MS = 5 * 60 * 1000;
  const OVERLAY_HARD_LIFETIME_MS = 2 * 60 * 60 * 1000;
  const OVERLAY_MAX_SESSIONS = 8;
  const OVERLAY_MAX_PENDING_PORTS = 8;
  const OVERLAY_MAX_PENDING_PORTS_PER_TAB = 2;
  const OVERLAY_MAX_PENDING_REQUESTS = 8;
  const OVERLAY_INVALID_CLAIM_WINDOW_MS = 60 * 1000;
  const OVERLAY_MAX_INVALID_CLAIMS_PER_TAB = 20;
  const OVERLAY_CLEANUP_ALARM = 'pinry-overlay-cleanup';
  const OVERLAY_EPOCH_ATTEMPTS = 8;
  const OVERLAY_PUBLIC_ERROR_CODES = new Set([
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
  const OVERLAY_RETRYABLE_BOOTSTRAP_CODES = new Set([
    'network_error', 'host_permission_required', 'webextension_api_error',
    'overlay_connection_lost',
  ]);
  const OVERLAY_JOB_STATES = new Set(['running', 'paused', 'completed']);
  const OVERLAY_ITEM_STATUSES = new Set([
    'pending', 'created', 'replayed', 'failed', 'conflict', 'unknown',
  ]);
  const OVERLAY_PAUSED_REASONS = new Set([
    'alarm_schedule_failed', 'discard_requested', 'host_permission_required',
    'invalid_server_response', 'retry_exhausted', 'server_configuration_changed',
  ]);
  const OVERLAY_ITEM_ERROR_CODES = new Set([
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

  function optionalVoidCall(method, receiver, args, runtime) {
    return new Promise((resolve, reject) => {
      let settled = false;
      function finish(error) {
        if (settled) return;
        settled = true;
        if (error || (runtime && runtime.lastError)) {
          reject(originApi.codeError('webextension_api_error'));
        } else {
          resolve();
        }
      }
      let returned;
      try {
        returned = method.apply(receiver, [...args, () => finish()]);
      } catch (_error) {
        finish(true);
        return;
      }
      if (returned && typeof returned.then === 'function') {
        returned.then(() => finish(), () => finish(true));
      } else if (method.length <= args.length) {
        finish();
      }
    });
  }

  function hasExactDataKeys(value, expectedKeys) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string')) return false;
      keys.sort();
      const expected = [...expectedKeys].sort();
      if (JSON.stringify(keys) !== JSON.stringify(expected)) return false;
      return keys.every((key) => descriptors[key].enumerable === true
        && Object.hasOwn(descriptors[key], 'value'));
    } catch (_error) {
      return false;
    }
  }

  function utf8ByteLength(value) {
    return new root.TextEncoder().encode(value).byteLength;
  }

  function fitsJsonByteLimit(value, limit) {
    let serialized;
    try {
      serialized = JSON.stringify(value);
    } catch (_error) {
      return false;
    }
    return typeof serialized === 'string' && utf8ByteLength(serialized) <= limit;
  }

  function isSafePositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function publicProjectionError() {
    throw originApi.codeError('invalid_server_response');
  }

  function publicDataField(value, key) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        publicProjectionError();
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) publicProjectionError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) publicProjectionError();
      return descriptor.value;
    } catch (error) {
      if (error && error.code === 'invalid_server_response') throw error;
      publicProjectionError();
    }
  }

  function publicString(value, maximumBytes, allowEmpty = true) {
    if (typeof value !== 'string' || !allowEmpty && value === ''
      || utf8ByteLength(value) > maximumBytes) publicProjectionError();
    return value;
  }

  function isCanonicalServerOrigin(value) {
    if (typeof value !== 'string' || utf8ByteLength(value) > OVERLAY_MAX_URL_BYTES) return false;
    try {
      return originApi.normalizeServerOrigin(value) === value;
    } catch (_error) {
      return false;
    }
  }

  function projectPlainArray(value, maximum, mapper) {
    try {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length > maximum) publicProjectionError();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const expectedKeys = ['length', ...Array.from({ length: value.length }, (_, index) => `${index}`)];
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string') || keys.length !== expectedKeys.length
        || expectedKeys.some((key) => !Object.hasOwn(descriptors, key))) {
        publicProjectionError();
      }
      return Object.freeze(expectedKeys.slice(1).map((key) => {
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          publicProjectionError();
        }
        return mapper(descriptor.value);
      }));
    } catch (error) {
      if (error && error.code === 'invalid_server_response') throw error;
      publicProjectionError();
    }
  }

  function projectOverlayErrorCode(value) {
    return typeof value === 'string' && (OVERLAY_ITEM_ERROR_CODES.has(value)
      || /^http_4[0-9]{2}$/.test(value) && value !== 'http_429') ? value : null;
  }

  function projectOverlayItem(value, includeRetryable) {
    const status = publicDataField(value, 'status');
    if (!OVERLAY_ITEM_STATUSES.has(status)) publicProjectionError();
    const rawError = publicDataField(value, 'error');
    let error = null;
    if (rawError !== null) {
      const code = projectOverlayErrorCode(publicDataField(rawError, 'code'));
      if (!code) publicProjectionError();
      error = Object.freeze({ code });
    }
    const projected = { status };
    if (includeRetryable) {
      const retryable = publicDataField(value, 'retryable');
      if (typeof retryable !== 'boolean') publicProjectionError();
      projected.retryable = retryable;
    }
    projected.error = error;
    return Object.freeze(projected);
  }

  function projectBootstrapJob(value) {
    if (value === null) return null;
    const batchId = publicString(publicDataField(value, 'batch_id'), 128, false);
    if (!isSafeProtocolId(batchId)) publicProjectionError();
    const jobState = publicDataField(value, 'job_state');
    const pausedReason = publicDataField(value, 'paused_reason');
    const revision = publicDataField(value, 'revision');
    const updatedAt = publicDataField(value, 'updated_at');
    const validPausedReason = pausedReason === null
      || OVERLAY_PAUSED_REASONS.has(pausedReason)
      || typeof pausedReason === 'string' && /^http_4[0-9]{2}$/.test(pausedReason)
        && pausedReason !== 'http_429';
    if (!OVERLAY_JOB_STATES.has(jobState) || !validPausedReason
      || !isSafePositiveInteger(revision)
      || !Number.isFinite(updatedAt) || updatedAt < 0) publicProjectionError();
    return Object.freeze({
      batch_id: batchId,
      job_state: jobState,
      paused_reason: pausedReason,
      revision,
      updated_at: updatedAt,
      items: projectPlainArray(
        publicDataField(value, 'items'),
        OVERLAY_MAX_CANDIDATES,
        (item) => projectOverlayItem(item, false),
      ),
    });
  }

  function projectBootstrap(value) {
    const configured = publicDataField(value, 'configured');
    const origin = publicDataField(value, 'origin');
    const username = publicDataField(value, 'username');
    const hasPermission = publicDataField(value, 'hasPermission');
    if (typeof configured !== 'boolean' || typeof hasPermission !== 'boolean') {
      publicProjectionError();
    }
    if (!configured) {
      if (origin !== null || username !== null || hasPermission) publicProjectionError();
    } else {
      if (!isCanonicalServerOrigin(origin) || typeof username !== 'string'
        || username === '' || utf8ByteLength(username) > OVERLAY_MAX_TAG_BYTES) {
        publicProjectionError();
      }
    }
    const boards = projectPlainArray(
      publicDataField(value, 'boards'),
      5000,
      (board) => {
        const id = publicDataField(board, 'id');
        const name = publicDataField(board, 'name');
        if (!isSafePositiveInteger(id)) publicProjectionError();
        return Object.freeze({ id, name: publicString(name, OVERLAY_MAX_TAG_BYTES) });
      },
    );
    const tags = projectPlainArray(
      publicDataField(value, 'tags'),
      5000,
      (tag) => publicString(tag, OVERLAY_MAX_TAG_BYTES),
    );
    if ((!configured || !hasPermission) && (boards.length !== 0 || tags.length !== 0)) {
      publicProjectionError();
    }
    return Object.freeze({
      configured,
      origin,
      username,
      hasPermission,
      boards,
      tags,
      current_job: projectBootstrapJob(publicDataField(value, 'current_job')),
    });
  }

  function projectOverlayJob(value) {
    const batchId = publicDataField(value, 'batch_id');
    const jobState = publicDataField(value, 'job_state');
    const origin = publicDataField(value, 'server_origin');
    const username = publicDataField(value, 'server_username');
    if (!isSafeProtocolId(batchId) || !OVERLAY_JOB_STATES.has(jobState)
      || !isCanonicalServerOrigin(origin) || typeof username !== 'string'
      || username === '' || utf8ByteLength(username) > OVERLAY_MAX_TAG_BYTES) {
      publicProjectionError();
    }
    return Object.freeze({
      batch_id: batchId,
      job_state: jobState,
      items: projectPlainArray(
        publicDataField(value, 'items'),
        OVERLAY_MAX_CANDIDATES,
        (item) => projectOverlayItem(item, true),
      ),
      server_origin: origin,
      server_username: username,
    });
  }

  function projectOverlaySuccess(requestType, value) {
    if (requestType === 'pinry:get-bootstrap') {
      return Object.freeze({ ok: true, bootstrap: projectBootstrap(value) });
    }
    if (requestType === 'pinry:create-board') {
      const id = publicDataField(value, 'id');
      const name = publicDataField(value, 'name');
      if (!isSafePositiveInteger(id)) publicProjectionError();
      return Object.freeze({ ok: true, id, name: publicString(name, OVERLAY_MAX_TAG_BYTES) });
    }
    if (requestType === 'pinry:create-job') {
      const batchId = publicDataField(value, 'batch_id');
      if (!isSafeProtocolId(batchId)) publicProjectionError();
      return Object.freeze({ ok: true, batch_id: batchId });
    }
    if (requestType === 'pinry:get-job') {
      return Object.freeze({ ok: true, job: projectOverlayJob(value) });
    }
    if (requestType === 'pinry:retry-job' || requestType === 'pinry:open-options') {
      if (publicDataField(value, 'ok') !== true) publicProjectionError();
      return Object.freeze({ ok: true });
    }
    if (requestType === 'pinry:discard-job') {
      if (hasExactDataKeys(value, ['ok']) && value.ok === true) {
        return Object.freeze({ ok: true });
      }
      if (!hasExactDataKeys(value, ['ok', 'cleanup_pending'])
        || value.ok !== true || typeof value.cleanup_pending !== 'boolean') {
        publicProjectionError();
      }
      return Object.freeze({ ok: true, cleanup_pending: value.cleanup_pending });
    }
    publicProjectionError();
  }

  function projectOverlayFailure(requestType, error) {
    let rawCode;
    try {
      const descriptor = error && typeof error === 'object'
        ? Object.getOwnPropertyDescriptor(error, 'code') : null;
      rawCode = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
    } catch (_error) {
      rawCode = null;
    }
    const code = typeof rawCode === 'string' && OVERLAY_PUBLIC_ERROR_CODES.has(rawCode)
      ? rawCode : 'unexpected_error';
    if (requestType === 'pinry:get-bootstrap') {
      return Object.freeze({
        ok: false,
        code,
        retryable: OVERLAY_RETRYABLE_BOOTSTRAP_CODES.has(code),
      });
    }
    return Object.freeze({ ok: false, code });
  }

  function createOverlayRequestHandler(controller) {
    return async function handleOverlayRequest({ sourceTabId, request }) {
      try {
        let result;
        if (request.type === 'pinry:get-bootstrap') {
          result = await controller.getBootstrap(sourceTabId);
        } else if (request.type === 'pinry:create-board') {
          result = await controller.createBoard(
            { name: request.name, private: request.private },
            request.expected_server,
          );
        } else if (request.type === 'pinry:create-job') {
          result = await controller.createJobBoundary(sourceTabId, request);
        } else if (request.type === 'pinry:get-job') {
          result = await controller.getJobForTab(sourceTabId, request.batch_id);
        } else if (request.type === 'pinry:retry-job') {
          result = await controller.retryJobForTab(sourceTabId, request.batch_id);
        } else if (request.type === 'pinry:discard-job') {
          result = await controller.discardJobForTab(sourceTabId, request.batch_id);
        } else if (request.type === 'pinry:open-options') {
          result = await controller.openOptions();
        } else {
          publicProjectionError();
        }
        return projectOverlaySuccess(request.type, result);
      } catch (error) {
        return projectOverlayFailure(request.type, error);
      }
    };
  }

  function isCanonicalHttpUrl(value, byteLimit = OVERLAY_MAX_URL_BYTES, allowHash = false) {
    if (typeof value !== 'string' || utf8ByteLength(value) > byteLimit) return false;
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_error) {
      return false;
    }
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.origin !== 'null' && parsed.username === '' && parsed.password === ''
      && (allowHash || parsed.hash === '') && parsed.href === value;
  }

  function overlayProtocolError() {
    throw originApi.codeError('overlay_protocol_error');
  }

  function dataDiscriminant(value, key) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.enumerable !== true
        || !Object.hasOwn(descriptor, 'value')) return undefined;
      return descriptor.value;
    } catch (_error) {
      return undefined;
    }
  }

  function mapPlainArray(value, maximum, mapper) {
    try {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        overlayProtocolError();
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) {
        overlayProtocolError();
      }
      const length = lengthDescriptor.value;
      const expectedKeys = ['length', ...Array.from({ length }, (_, index) => String(index))];
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== 'string')
        || keys.length !== expectedKeys.length
        || expectedKeys.some((key) => !Object.hasOwn(descriptors, key))) {
        overlayProtocolError();
      }
      const copied = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || descriptor.enumerable !== true
          || !Object.hasOwn(descriptor, 'value')) overlayProtocolError();
        copied.push(mapper(descriptor.value, index));
      }
      return Object.freeze(copied);
    } catch (error) {
      if (error && error.code === 'overlay_protocol_error') throw error;
      overlayProtocolError();
    }
  }

  function validateOverlayPageDefaults(value, fallbackUrl = '') {
    if (!hasExactDataKeys(value, ['description', 'referer'])) overlayProtocolError();
    const { description, referer } = value;
    if (typeof description !== 'string'
      || utf8ByteLength(description) > OVERLAY_MAX_STRING_BYTES
      || typeof referer !== 'string') overlayProtocolError();
    const normalizedReferer = isCanonicalHttpUrl(
      referer,
      OVERLAY_MAX_STRING_BYTES,
      true,
    ) ? referer : isCanonicalHttpUrl(
      fallbackUrl,
      OVERLAY_MAX_STRING_BYTES,
      true,
    ) ? fallbackUrl : '';
    return Object.freeze({ description, referer: normalizedReferer });
  }

  function validateOverlayCandidateState(value) {
    const status = dataDiscriminant(value, 'status');
    let normalized;
    if (status === 'pending') {
      if (!hasExactDataKeys(value, ['status'])) overlayProtocolError();
      normalized = Object.freeze({ status });
    } else if (status === 'error') {
      if (!hasExactDataKeys(value, ['status', 'code'])
        || (value.code !== 'candidate_collection_failed'
          && value.code !== 'candidate_payload_too_large')) overlayProtocolError();
      normalized = Object.freeze({ status, code: value.code });
    } else if (status === 'result') {
      if (!hasExactDataKeys(value, ['status', 'result'])
        || !hasExactDataKeys(value.result, [
          'candidates', 'totalCandidates', 'truncated',
        ])) overlayProtocolError();
      const seenIds = new Set();
      const seenUrls = new Set();
      const candidates = mapPlainArray(
        value.result.candidates,
        OVERLAY_MAX_CANDIDATES,
        (item) => {
          if (!hasExactDataKeys(item, [
            'id', 'url', 'sourceType', 'width', 'height',
          ]) || !isCanonicalHttpUrl(item.url)
            || item.id !== `pinry-candidate:${item.url}`
            || (item.sourceType !== 'img' && item.sourceType !== 'background')
            || !isSafePositiveInteger(item.width) || item.width > OVERLAY_MAX_DIMENSION
            || !isSafePositiveInteger(item.height) || item.height > OVERLAY_MAX_DIMENSION
            || seenIds.has(item.id) || seenUrls.has(item.url)) overlayProtocolError();
          seenIds.add(item.id);
          seenUrls.add(item.url);
          return Object.freeze({
            id: item.id,
            url: item.url,
            sourceType: item.sourceType,
            width: item.width,
            height: item.height,
          });
        },
      );
      const { totalCandidates, truncated } = value.result;
      if (!Number.isSafeInteger(totalCandidates) || totalCandidates < candidates.length
        || typeof truncated !== 'boolean'
        || truncated !== (totalCandidates > candidates.length)) overlayProtocolError();
      normalized = Object.freeze({
        status,
        result: Object.freeze({ candidates, totalCandidates, truncated }),
      });
    } else {
      overlayProtocolError();
    }
    if (!fitsJsonByteLimit(normalized, OVERLAY_MAX_CANDIDATE_BYTES)) {
      throw originApi.codeError('candidate_payload_too_large');
    }
    return normalized;
  }

  function isOverlaySessionId(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  }

  function validateOverlayRegisterEnvelope(value, fallbackUrl = '') {
    if (!hasExactDataKeys(value, [
      'version', 'kind', 'session_id', 'issued_at', 'page_defaults', 'candidate_state',
    ]) || value.version !== 1 || value.kind !== 'register'
      || !isOverlaySessionId(value.session_id)
      || !Number.isSafeInteger(value.issued_at) || value.issued_at < 0) overlayProtocolError();
    const pageDefaults = validateOverlayPageDefaults(value.page_defaults, fallbackUrl);
    const candidateState = validateOverlayCandidateState(value.candidate_state);
    const wireEnvelope = {
      version: 1,
      kind: 'register',
      session_id: value.session_id,
      issued_at: value.issued_at,
      page_defaults: pageDefaults,
      candidate_state: candidateState,
    };
    if (!fitsJsonByteLimit(wireEnvelope, OVERLAY_MAX_ENVELOPE_BYTES)) {
      throw originApi.codeError('candidate_payload_too_large');
    }
    return Object.freeze({
      sessionId: value.session_id,
      issuedAt: value.issued_at,
      pageDefaults,
      candidateState,
    });
  }

  function validateOverlayClaimEnvelope(value) {
    if (!hasExactDataKeys(value, ['version', 'kind', 'session_id'])
      || value.version !== 1 || value.kind !== 'claim'
      || !isOverlaySessionId(value.session_id)) overlayProtocolError();
    const sessionId = value.session_id;
    const wireEnvelope = { version: 1, kind: 'claim', session_id: sessionId };
    if (!fitsJsonByteLimit(wireEnvelope, OVERLAY_MAX_ENVELOPE_BYTES)) {
      overlayProtocolError();
    }
    return Object.freeze({ sessionId });
  }

  function validateExpectedServer(value) {
    if (!hasExactDataKeys(value, ['origin', 'username'])
      || typeof value.origin !== 'string'
      || utf8ByteLength(value.origin) > OVERLAY_MAX_URL_BYTES
      || typeof value.username !== 'string' || value.username === ''
      || utf8ByteLength(value.username) > OVERLAY_MAX_TAG_BYTES) overlayProtocolError();
    let parsed;
    try {
      parsed = new URL(value.origin);
    } catch (_error) {
      overlayProtocolError();
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || parsed.origin === 'null' || parsed.username !== '' || parsed.password !== ''
      || parsed.origin !== value.origin || parsed.pathname !== '/'
      || parsed.search !== '' || parsed.hash !== '') overlayProtocolError();
    return Object.freeze({ origin: value.origin, username: value.username });
  }

  function validateOverlayMetadata(value) {
    if (!hasExactDataKeys(value, [
      'board_ids', 'tags', 'private', 'referer', 'description',
    ]) || typeof value.private !== 'boolean'
      || typeof value.referer !== 'string'
      || utf8ByteLength(value.referer) > OVERLAY_MAX_STRING_BYTES
      || typeof value.description !== 'string'
      || utf8ByteLength(value.description) > OVERLAY_MAX_STRING_BYTES) overlayProtocolError();
    const boardIds = mapPlainArray(value.board_ids, OVERLAY_MAX_CANDIDATES, (boardId) => {
      if (!isSafePositiveInteger(boardId)) overlayProtocolError();
      return boardId;
    });
    const tags = mapPlainArray(value.tags, OVERLAY_MAX_CANDIDATES, (tag) => {
      if (typeof tag !== 'string' || utf8ByteLength(tag) > OVERLAY_MAX_TAG_BYTES) {
        overlayProtocolError();
      }
      return tag;
    });
    return Object.freeze({
      board_ids: boardIds,
      tags,
      private: value.private,
      referer: value.referer,
      description: value.description,
    });
  }

  function validateJobCandidate(value) {
    if (!hasExactDataKeys(value, ['url']) || !isCanonicalHttpUrl(value.url)) {
      overlayProtocolError();
    }
    return Object.freeze({ url: value.url });
  }

  function isSafeProtocolId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  }

  function validateOverlayRequest(value) {
    const type = dataDiscriminant(value, 'type');
    let normalized;
    if (type === 'pinry:get-bootstrap' || type === 'pinry:open-options') {
      if (!hasExactDataKeys(value, ['type'])) overlayProtocolError();
      normalized = Object.freeze({ type });
    } else if (type === 'pinry:create-board') {
      if (!hasExactDataKeys(value, ['type', 'name', 'private', 'expected_server'])
        || typeof value.name !== 'string' || typeof value.private !== 'boolean') {
        overlayProtocolError();
      }
      const name = value.name.trim();
      if (name.length < 1 || name.length > 128) overlayProtocolError();
      normalized = Object.freeze({
        type,
        name,
        private: value.private,
        expected_server: validateExpectedServer(value.expected_server),
      });
    } else if (type === 'pinry:create-job') {
      if (!hasExactDataKeys(value, [
        'type', 'candidates', 'metadata', 'expected_server',
      ])) overlayProtocolError();
      normalized = Object.freeze({
        type,
        candidates: mapPlainArray(
          value.candidates,
          OVERLAY_MAX_CANDIDATES,
          validateJobCandidate,
        ),
        metadata: validateOverlayMetadata(value.metadata),
        expected_server: validateExpectedServer(value.expected_server),
      });
    } else if (type === 'pinry:get-job' || type === 'pinry:retry-job'
      || type === 'pinry:discard-job') {
      if (!hasExactDataKeys(value, ['type', 'batch_id'])
        || !isSafeProtocolId(value.batch_id)) overlayProtocolError();
      normalized = Object.freeze({ type, batch_id: value.batch_id });
    } else {
      overlayProtocolError();
    }
    if (!fitsJsonByteLimit(normalized, OVERLAY_MAX_ENVELOPE_BYTES)) overlayProtocolError();
    return normalized;
  }

  function validateOverlayLauncherEnvelope(value) {
    const kind = dataDiscriminant(value, 'kind');
    let normalized;
    let wireEnvelope;
    if (kind === 'state') {
      if (!hasExactDataKeys(value, [
        'version', 'kind', 'connection_epoch', 'candidate_state',
      ]) || value.version !== 1 || !isSafePositiveInteger(value.connection_epoch)) {
        overlayProtocolError();
      }
      const candidateState = validateOverlayCandidateState(value.candidate_state);
      normalized = Object.freeze({
        kind,
        connectionEpoch: value.connection_epoch,
        candidateState,
      });
      wireEnvelope = {
        version: 1,
        kind,
        connection_epoch: normalized.connectionEpoch,
        candidate_state: candidateState,
      };
    } else if (kind === 'authorize-result') {
      if (!hasExactDataKeys(value, [
        'version', 'kind', 'connection_epoch', 'request_id', 'allowed',
      ]) || value.version !== 1 || !isSafePositiveInteger(value.connection_epoch)
        || !isSafePositiveInteger(value.request_id)
        || typeof value.allowed !== 'boolean') overlayProtocolError();
      normalized = Object.freeze({
        kind,
        connectionEpoch: value.connection_epoch,
        requestId: value.request_id,
        allowed: value.allowed,
      });
      wireEnvelope = {
        version: 1,
        kind,
        connection_epoch: normalized.connectionEpoch,
        request_id: normalized.requestId,
        allowed: normalized.allowed,
      };
    } else if (kind === 'host-removed') {
      if (!hasExactDataKeys(value, [
        'version', 'kind', 'connection_epoch', 'close_id',
      ]) || value.version !== 1 || !isSafePositiveInteger(value.connection_epoch)
        || !isSafePositiveInteger(value.close_id)) overlayProtocolError();
      normalized = Object.freeze({
        kind,
        connectionEpoch: value.connection_epoch,
        closeId: value.close_id,
      });
      wireEnvelope = {
        version: 1,
        kind,
        connection_epoch: normalized.connectionEpoch,
        close_id: normalized.closeId,
      };
    } else if (kind === 'focus' || kind === 'close') {
      if (!hasExactDataKeys(value, ['version', 'kind', 'connection_epoch'])
        || value.version !== 1 || !isSafePositiveInteger(value.connection_epoch)) {
        overlayProtocolError();
      }
      normalized = Object.freeze({ kind, connectionEpoch: value.connection_epoch });
      wireEnvelope = {
        version: 1,
        kind,
        connection_epoch: normalized.connectionEpoch,
      };
    } else if (kind === 'abort') {
      if (!hasExactDataKeys(value, ['version', 'kind', 'connection_epoch', 'code'])
        || value.version !== 1 || !isSafePositiveInteger(value.connection_epoch)
        || value.code !== 'overlay_integrity_failed') overlayProtocolError();
      normalized = Object.freeze({
        kind,
        connectionEpoch: value.connection_epoch,
        code: value.code,
      });
      wireEnvelope = {
        version: 1,
        kind,
        connection_epoch: normalized.connectionEpoch,
        code: normalized.code,
      };
    } else {
      overlayProtocolError();
    }
    if (!fitsJsonByteLimit(wireEnvelope, OVERLAY_MAX_ENVELOPE_BYTES)) overlayProtocolError();
    return normalized;
  }

  function validateOverlayFrameEnvelope(value) {
    const kind = dataDiscriminant(value, 'kind');
    let normalized;
    let wireEnvelope;
    if (kind === 'request') {
      if (!hasExactDataKeys(value, [
        'version', 'kind', 'connection_epoch', 'request_id', 'request',
      ]) || value.version !== 1 || !isSafePositiveInteger(value.connection_epoch)
        || !isSafePositiveInteger(value.request_id)) overlayProtocolError();
      const request = validateOverlayRequest(value.request);
      normalized = Object.freeze({
        kind,
        connectionEpoch: value.connection_epoch,
        requestId: value.request_id,
        request,
      });
      wireEnvelope = {
        version: 1,
        kind,
        connection_epoch: normalized.connectionEpoch,
        request_id: normalized.requestId,
        request,
      };
    } else if (kind === 'close') {
      if (!hasExactDataKeys(value, [
        'version', 'kind', 'connection_epoch', 'close_id',
      ]) || value.version !== 1 || !isSafePositiveInteger(value.connection_epoch)
        || !isSafePositiveInteger(value.close_id)) overlayProtocolError();
      normalized = Object.freeze({
        kind,
        connectionEpoch: value.connection_epoch,
        closeId: value.close_id,
      });
      wireEnvelope = {
        version: 1,
        kind,
        connection_epoch: normalized.connectionEpoch,
        close_id: normalized.closeId,
      };
    } else {
      overlayProtocolError();
    }
    if (!fitsJsonByteLimit(wireEnvelope, OVERLAY_MAX_ENVELOPE_BYTES)) overlayProtocolError();
    return normalized;
  }

  function overlayManagerConfigurationError() {
    return new Error('overlay_manager_configuration_invalid');
  }

  function generateConnectionEpoch(cryptoApi) {
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
      throw overlayManagerConfigurationError();
    }
    for (let attempt = 0; attempt < OVERLAY_EPOCH_ATTEMPTS; attempt += 1) {
      const words = new Uint32Array(2);
      try {
        cryptoApi.getRandomValues(words);
      } catch (_error) {
        throw overlayManagerConfigurationError();
      }
      const epoch = (words[0] & 0x1fffff) * 0x100000000 + words[1];
      if (Number.isSafeInteger(epoch) && epoch > 0) return epoch;
    }
    throw overlayManagerConfigurationError();
  }

  function createOverlaySessionManager(options) {
    if (!options || !options.chromeApi || typeof options.requestHandler !== 'function') {
      throw overlayManagerConfigurationError();
    }
    const { chromeApi } = options;
    const now = options.now || Date.now;
    const setTimeoutImpl = options.setTimeoutImpl || (typeof root.setTimeout === 'function'
      ? root.setTimeout.bind(root) : null);
    const clearTimeoutImpl = options.clearTimeoutImpl || (typeof root.clearTimeout === 'function'
      ? root.clearTimeout.bind(root) : null);
    const connectionEpochFactory = options.connectionEpochFactory
      || (() => generateConnectionEpoch(root.crypto));
    if (!chromeApi.runtime || typeof chromeApi.runtime.getURL !== 'function'
      || typeof now !== 'function' || typeof setTimeoutImpl !== 'function'
      || typeof clearTimeoutImpl !== 'function'
      || typeof connectionEpochFactory !== 'function') {
      throw overlayManagerConfigurationError();
    }

    const sessionsByCapability = new Map();
    const sessionsByTab = new Map();
    const pendingPorts = new Map();
    const pendingPortCountsByTab = new Map();
    const invalidClaimsByTab = new Map();

    function disconnectBestEffort(port) {
      if (!port || typeof port.disconnect !== 'function') return;
      try {
        port.disconnect();
      } catch (_error) {
        // Port 정리는 best effort로 종료한다.
      }
    }

    function postBestEffort(port, message) {
      if (!port || typeof port.postMessage !== 'function') return false;
      try {
        port.postMessage(message);
        return true;
      } catch (_error) {
        return false;
      }
    }

    function isCurrentSession(session) {
      return sessionsByCapability.get(session.sessionId) === session
        && sessionsByTab.get(session.sourceTabId) === session;
    }

    function isCurrentPortSession(session, port) {
      return isCurrentSession(session)
        && (port === session.launcherPort || port === session.framePort);
    }

    function sameCurrentSession(session, port, epoch) {
      return isCurrentPortSession(session, port)
        && session.launcherPort
        && session.connectionEpoch === epoch;
    }

    function removeSessionFromIndexes(session) {
      if (sessionsByCapability.get(session.sessionId) === session) {
        sessionsByCapability.delete(session.sessionId);
      }
      if (sessionsByTab.get(session.sourceTabId) === session) {
        sessionsByTab.delete(session.sourceTabId);
      }
    }

    function clearPendingSessionWork(session) {
      for (const authorization of session.pendingAuthorizations.values()) {
        if (authorization.timer !== null) clearTimeoutImpl(authorization.timer);
      }
      session.pendingRequests.clear();
      session.pendingAuthorizations.clear();
      session.pendingFocus = false;
    }

    function clearSessionTimer(session, key) {
      if (session[key] === null) return;
      clearTimeoutImpl(session[key]);
      session[key] = null;
    }

    function clearSessionTimers(session) {
      clearSessionTimer(session, 'unclaimedTimer');
      clearSessionTimer(session, 'frameReconnectTimer');
      clearSessionTimer(session, 'closeTimer');
    }

    function fatalEnvelope(session, code) {
      return {
        version: 1,
        kind: 'fatal',
        connection_epoch: session.connectionEpoch,
        code,
      };
    }

    function closeSession(session, state, code) {
      if (!isCurrentSession(session)) return;
      session.state = state;
      removeSessionFromIndexes(session);
      clearPendingSessionWork(session);
      clearSessionTimers(session);
      if (code) {
        const message = fatalEnvelope(session, code);
        postBestEffort(session.launcherPort, message);
        postBestEffort(session.framePort, message);
      }
      disconnectBestEffort(session.launcherPort);
      disconnectBestEffort(session.framePort);
    }

    function failProtocol(session, port) {
      if (isCurrentPortSession(session, port)) {
        closeSession(session, 'FAILED', 'overlay_protocol_error');
      } else {
        disconnectBestEffort(port);
      }
    }

    function failSessionIntegrity(session) {
      if (!isCurrentSession(session)) return;
      closeSession(session, 'FAILED', 'overlay_integrity_failed');
    }

    function isCurrentRequest(session, record) {
      return isCurrentSession(session)
        && session.state === 'PAIRED'
        && session.connectionEpoch === record.connectionEpoch
        && session.framePort === record.framePort
        && session.pendingRequests.get(record.requestId) === record;
    }

    function clearAuthorization(session, record) {
      if (session.pendingAuthorizations.get(record.requestId) === record) {
        session.pendingAuthorizations.delete(record.requestId);
      }
      if (record.timer !== null) {
        clearTimeoutImpl(record.timer);
        record.timer = null;
      }
    }

    function sendOverlayResponse(session, record, response) {
      if (!isCurrentRequest(session, record) || record.dispatched !== true) return;
      session.pendingRequests.delete(record.requestId);
      let envelope = {
        version: 1,
        kind: 'response',
        connection_epoch: record.connectionEpoch,
        request_id: record.requestId,
        response,
      };
      if (!fitsJsonByteLimit(envelope, OVERLAY_MAX_ENVELOPE_BYTES)) {
        envelope = {
          version: 1,
          kind: 'response',
          connection_epoch: record.connectionEpoch,
          request_id: record.requestId,
          response: { ok: false, code: 'invalid_server_response' },
        };
      }
      if (!postBestEffort(record.framePort, envelope)) closeSession(session, 'FAILED');
    }

    function dispatchOverlayRequest(session, record) {
      if (!isCurrentRequest(session, record) || record.dispatched) return;
      clearAuthorization(session, record);
      record.dispatched = true;
      let operation;
      try {
        if (!isCurrentRequest(session, record)) return;
        operation = options.requestHandler({
          sourceTabId: session.sourceTabId,
          request: record.request,
        });
      } catch (error) {
        operation = Promise.reject(error);
      }
      Promise.resolve(operation).then(
        (response) => sendOverlayResponse(session, record, response),
        (error) => sendOverlayResponse(
          session,
          record,
          projectOverlayFailure(record.request.type, error),
        ),
      );
    }

    function authorizeOverlayRequest(session, record) {
      record.timer = setTimeoutImpl(() => {
        record.timer = null;
        if (isCurrentRequest(session, record)
          && session.pendingAuthorizations.get(record.requestId) === record) {
          failSessionIntegrity(session);
        }
      }, OVERLAY_AUTHORIZE_TIMEOUT_MS);
      session.pendingAuthorizations.set(record.requestId, record);
      if (!postBestEffort(session.launcherPort, {
        version: 1,
        kind: 'authorize',
        connection_epoch: record.connectionEpoch,
        request_id: record.requestId,
      })) failSessionIntegrity(session);
    }

    function allocateConnectionEpoch() {
      for (let attempt = 0; attempt < OVERLAY_EPOCH_ATTEMPTS; attempt += 1) {
        const epoch = connectionEpochFactory();
        if (!Number.isSafeInteger(epoch) || epoch <= 0) break;
        const collision = [...sessionsByCapability.values()].some(
          (session) => session.connectionEpoch === epoch,
        );
        if (!collision) return epoch;
      }
      throw overlayManagerConfigurationError();
    }

    function sessionStateEnvelope(session) {
      return {
        version: 1,
        kind: 'session-state',
        connection_epoch: session.connectionEpoch,
        page_defaults: session.pageDefaults,
        candidate_state: session.candidateState,
      };
    }

    function forwardSessionState(session) {
      return postBestEffort(session.framePort, sessionStateEnvelope(session));
    }

    function sessionExpired(session, currentTime) {
      return session.issuedAt + OVERLAY_HARD_LIFETIME_MS <= currentTime
        || session.lastValidatedAt + OVERLAY_IDLE_TIMEOUT_MS <= currentTime
        || session.state === 'REGISTERED'
          && session.unclaimedDeadline <= currentTime
        || session.state === 'FRAME_RECONNECTING'
          && session.frameReconnectDeadline <= currentTime;
    }

    function sweepExpiredSessions() {
      const currentTime = now();
      if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
        for (const session of [...sessionsByCapability.values()]) {
          closeSession(session, 'FAILED');
        }
        return;
      }
      for (const session of [...sessionsByCapability.values()]) {
        if (session.state === 'CLOSING' && session.closeDeadline <= currentTime) {
          closeSession(session, 'CLOSED');
        } else if (sessionExpired(session, currentTime)) {
          closeSession(session, 'FAILED', 'overlay_session_expired');
        }
      }
      for (const tabId of [...invalidClaimsByTab.keys()]) invalidClaimTimestamps(tabId);
    }

    function scheduleSessionSweep(session, key, delay) {
      clearSessionTimer(session, key);
      session[key] = setTimeoutImpl(() => {
        session[key] = null;
        if (isCurrentSession(session)) sweepExpiredSessions();
      }, delay);
    }

    function rawSenderTabId(port) {
      try {
        const senderDescriptor = Object.getOwnPropertyDescriptor(port, 'sender');
        if (!senderDescriptor || !Object.hasOwn(senderDescriptor, 'value')) return null;
        const tabDescriptor = Object.getOwnPropertyDescriptor(senderDescriptor.value, 'tab');
        if (!tabDescriptor || !Object.hasOwn(tabDescriptor, 'value')) return null;
        const idDescriptor = Object.getOwnPropertyDescriptor(tabDescriptor.value, 'id');
        if (!idDescriptor || !Object.hasOwn(idDescriptor, 'value')
          || !Number.isSafeInteger(idDescriptor.value) || idDescriptor.value < 0) return null;
        return idDescriptor.value;
      } catch (_error) {
        return null;
      }
    }

    function reservePendingPort(port) {
      if (pendingPorts.has(port)) return false;
      const tabId = rawSenderTabId(port);
      const tabCount = tabId === null ? 0 : pendingPortCountsByTab.get(tabId) || 0;
      if (pendingPorts.size >= OVERLAY_MAX_PENDING_PORTS
        || tabId !== null && tabCount >= OVERLAY_MAX_PENDING_PORTS_PER_TAB) return false;
      pendingPorts.set(port, tabId);
      if (tabId !== null) pendingPortCountsByTab.set(tabId, tabCount + 1);
      return true;
    }

    function releasePendingPort(port) {
      if (!pendingPorts.has(port)) return;
      const tabId = pendingPorts.get(port);
      pendingPorts.delete(port);
      if (tabId === null) return;
      const count = pendingPortCountsByTab.get(tabId) || 0;
      if (count <= 1) pendingPortCountsByTab.delete(tabId);
      else pendingPortCountsByTab.set(tabId, count - 1);
    }

    function invalidClaimTimestamps(tabId) {
      if (tabId === null) return [];
      const threshold = now() - OVERLAY_INVALID_CLAIM_WINDOW_MS;
      const timestamps = (invalidClaimsByTab.get(tabId) || [])
        .filter((timestamp) => timestamp > threshold);
      if (timestamps.length === 0) invalidClaimsByTab.delete(tabId);
      else invalidClaimsByTab.set(tabId, timestamps);
      return timestamps;
    }

    function mayInspectClaim(port) {
      return invalidClaimTimestamps(rawSenderTabId(port)).length
        < OVERLAY_MAX_INVALID_CLAIMS_PER_TAB;
    }

    function recordInvalidClaim(port) {
      const tabId = rawSenderTabId(port);
      if (tabId === null) return;
      const timestamps = invalidClaimTimestamps(tabId);
      timestamps.push(now());
      invalidClaimsByTab.set(tabId, timestamps);
    }

    function registerLauncher(port, message) {
      sweepExpiredSessions();
      const senderInfo = originApi.inspectOverlayLauncherSender(
        port.sender,
        chromeApi.runtime,
      );
      if (!senderInfo) return null;

      let registration;
      try {
        registration = validateOverlayRegisterEnvelope(message, senderInfo.url);
      } catch (_error) {
        return null;
      }
      const validatedAt = now();
      if (!Number.isSafeInteger(validatedAt) || validatedAt < 0) return null;
      if (registration.issuedAt > validatedAt + OVERLAY_FUTURE_SKEW_MS
        || registration.issuedAt + OVERLAY_HARD_LIFETIME_MS <= validatedAt) {
        postBestEffort(port, {
          version: 1,
          kind: 'rejected',
          code: 'overlay_session_expired',
        });
        return null;
      }

      const existingForTab = sessionsByTab.get(senderInfo.tabId);
      const existingForCapability = sessionsByCapability.get(registration.sessionId);
      if (existingForCapability) return null;
      if (sessionsByCapability.size - (existingForTab ? 1 : 0)
        >= OVERLAY_MAX_SESSIONS) {
        postBestEffort(port, {
          version: 1,
          kind: 'rejected',
          code: 'overlay_session_limit',
        });
        return null;
      }

      let connectionEpoch;
      try {
        connectionEpoch = allocateConnectionEpoch();
      } catch (_error) {
        return null;
      }
      const session = {
        sessionId: registration.sessionId,
        sourceTabId: senderInfo.tabId,
        launcherPort: port,
        issuedAt: registration.issuedAt,
        connectionEpoch,
        state: 'REGISTERING',
        lastValidatedAt: validatedAt,
        candidateState: registration.candidateState,
        pageDefaults: registration.pageDefaults,
        framePort: null,
        frameId: null,
        documentId: null,
        lastAcceptedFrameRequestId: 0,
        pendingRequests: new Map(),
        pendingAuthorizations: new Map(),
        pendingFocus: false,
        closeId: null,
        unclaimedDeadline: validatedAt + OVERLAY_BACKGROUND_GRACE_MS,
        frameReconnectDeadline: null,
        closeDeadline: null,
        unclaimedTimer: null,
        frameReconnectTimer: null,
        closeTimer: null,
      };

      if (existingForTab) {
        existingForTab.state = 'REPLACED';
        removeSessionFromIndexes(existingForTab);
        clearPendingSessionWork(existingForTab);
        clearSessionTimers(existingForTab);
      }
      sessionsByCapability.set(session.sessionId, session);
      sessionsByTab.set(session.sourceTabId, session);
      session.state = 'REGISTERED';
      if (existingForTab) {
        const replaced = fatalEnvelope(existingForTab, 'overlay_session_replaced');
        postBestEffort(existingForTab.launcherPort, replaced);
        postBestEffort(existingForTab.framePort, replaced);
        disconnectBestEffort(existingForTab.launcherPort);
        disconnectBestEffort(existingForTab.framePort);
      }

      if (!postBestEffort(port, {
        version: 1,
        kind: 'registered',
        connection_epoch: connectionEpoch,
      })) {
        closeSession(session, 'FAILED');
        return null;
      }
      scheduleSessionSweep(session, 'unclaimedTimer', OVERLAY_BACKGROUND_GRACE_MS);
      return session;
    }

    function sameReclaimSender(session, senderInfo) {
      return senderInfo.tabId === session.sourceTabId
        && senderInfo.hash === ''
        && senderInfo.frameId === session.frameId
        && senderInfo.documentId === session.documentId;
    }

    function completeFrameClaim(session, port, senderInfo, reconnecting) {
      session.framePort = port;
      if (!reconnecting) {
        session.frameId = senderInfo.frameId;
        session.documentId = senderInfo.documentId;
      }
      session.lastValidatedAt = now();
      clearSessionTimer(session, 'unclaimedTimer');
      clearSessionTimer(session, 'frameReconnectTimer');
      session.frameReconnectDeadline = null;
      if (session.state !== 'CLOSING') session.state = 'PAIRED';
      const claimed = postBestEffort(port, {
        version: 1,
        kind: 'claimed',
        connection_epoch: session.connectionEpoch,
      });
      const stateSent = forwardSessionState(session);
      const paired = session.state === 'CLOSING' || postBestEffort(session.launcherPort, {
        version: 1,
        kind: 'paired',
        connection_epoch: session.connectionEpoch,
      });
      let focusSent = true;
      if (session.pendingFocus && session.state === 'PAIRED') {
        session.pendingFocus = false;
        focusSent = postBestEffort(port, {
          version: 1,
          kind: 'focus',
          connection_epoch: session.connectionEpoch,
        });
      }
      if (!claimed || !paired || !stateSent || !focusSent) {
        closeSession(session, 'FAILED');
        return null;
      }
      return session;
    }

    function claimFrame(port, message) {
      sweepExpiredSessions();
      const senderInfo = originApi.inspectOverlayFrameSender(port.sender, chromeApi.runtime);
      if (!senderInfo) return null;
      let claim;
      try {
        claim = validateOverlayClaimEnvelope(message);
      } catch (_error) {
        return null;
      }
      const session = sessionsByCapability.get(claim.sessionId);
      if (!session || !isCurrentSession(session) || !session.launcherPort
        || session.framePort || senderInfo.tabId !== session.sourceTabId) return null;
      if (session.state === 'REGISTERED') {
        if (senderInfo.hash !== `#${session.sessionId}` && senderInfo.hash !== '') return null;
        return completeFrameClaim(session, port, senderInfo, false);
      }
      if ((session.state === 'FRAME_RECONNECTING' || session.state === 'CLOSING')
        && sameReclaimSender(session, senderInfo)) {
        return completeFrameClaim(session, port, senderInfo, true);
      }
      return null;
    }

    function beginFrameReconnect(session) {
      if (!isCurrentSession(session) || session.state !== 'PAIRED') return;
      session.state = 'FRAME_RECONNECTING';
      session.framePort = null;
      clearPendingSessionWork(session);
      session.frameReconnectDeadline = now() + OVERLAY_BACKGROUND_GRACE_MS;
      if (!postBestEffort(session.launcherPort, {
        version: 1,
        kind: 'frame-reconnecting',
        connection_epoch: session.connectionEpoch,
      })) {
        closeSession(session, 'FAILED');
        return;
      }
      scheduleSessionSweep(session, 'frameReconnectTimer', OVERLAY_BACKGROUND_GRACE_MS);
    }

    function updateCandidateState(session, candidateState) {
      const currentStatus = session.candidateState.status;
      const nextStatus = candidateState.status;
      if (currentStatus === 'pending' && (nextStatus === 'result' || nextStatus === 'error')) {
        session.candidateState = candidateState;
        return session.state !== 'PAIRED' || forwardSessionState(session);
      }
      if (currentStatus !== 'pending' && nextStatus === currentStatus
        && JSON.stringify(session.candidateState) === JSON.stringify(candidateState)) {
        return true;
      }
      return false;
    }

    function handleLauncherMessage(session, port, message) {
      sweepExpiredSessions();
      let envelope;
      try {
        envelope = validateOverlayLauncherEnvelope(message);
      } catch (_error) {
        failProtocol(session, port);
        return;
      }
      if (!sameCurrentSession(session, port, envelope.connectionEpoch)) {
        failProtocol(session, port);
        return;
      }
      session.lastValidatedAt = now();
      if (session.state === 'CLOSING') {
        if (envelope.kind === 'host-removed' && envelope.closeId === session.closeId) {
          closeSession(session, 'CLOSED');
        } else {
          failProtocol(session, port);
        }
        return;
      }
      if (envelope.kind === 'state') {
        if (!updateCandidateState(session, envelope.candidateState)) {
          failProtocol(session, port);
        }
      } else if (envelope.kind === 'focus') {
        if (session.state === 'PAIRED' && session.framePort) {
          if (!postBestEffort(session.framePort, {
            version: 1,
            kind: 'focus',
            connection_epoch: session.connectionEpoch,
          })) failProtocol(session, port);
        } else {
          session.pendingFocus = true;
        }
      } else if (envelope.kind === 'close') {
        closeSession(session, 'CLOSED');
      } else if (envelope.kind === 'abort') {
        failSessionIntegrity(session);
      } else if (envelope.kind === 'authorize-result') {
        const record = session.pendingAuthorizations.get(envelope.requestId);
        if (!record || !isCurrentRequest(session, record)) {
          failSessionIntegrity(session);
        } else if (!envelope.allowed) {
          failSessionIntegrity(session);
        } else {
          clearAuthorization(session, record);
          Promise.resolve().then(() => dispatchOverlayRequest(session, record));
        }
      } else {
        failProtocol(session, port);
      }
    }

    function beginClose(session, closeId) {
      session.state = 'CLOSING';
      session.closeId = closeId;
      clearPendingSessionWork(session);
      session.closeDeadline = now() + OVERLAY_CLOSE_FALLBACK_MS;
      const closing = postBestEffort(session.framePort, {
        version: 1,
        kind: 'closing',
        connection_epoch: session.connectionEpoch,
        close_id: closeId,
      });
      const removeHost = postBestEffort(session.launcherPort, {
        version: 1,
        kind: 'remove-host',
        connection_epoch: session.connectionEpoch,
        close_id: closeId,
      });
      if (!closing || !removeHost) {
        closeSession(session, 'FAILED');
        return;
      }
      scheduleSessionSweep(session, 'closeTimer', OVERLAY_CLOSE_FALLBACK_MS);
    }

    function handleFrameMessage(session, port, message) {
      sweepExpiredSessions();
      let envelope;
      try {
        envelope = validateOverlayFrameEnvelope(message);
      } catch (_error) {
        failProtocol(session, port);
        return;
      }
      if (!sameCurrentSession(session, port, envelope.connectionEpoch)) {
        failProtocol(session, port);
        return;
      }
      session.lastValidatedAt = now();
      if (envelope.kind === 'close') {
        if (session.state === 'PAIRED') {
          beginClose(session, envelope.closeId);
        } else if (session.state === 'CLOSING' && envelope.closeId === session.closeId) {
          if (!postBestEffort(port, {
            version: 1,
            kind: 'closing',
            connection_epoch: session.connectionEpoch,
            close_id: session.closeId,
          })) closeSession(session, 'FAILED');
        } else {
          failProtocol(session, port);
        }
        return;
      }
      if (session.state !== 'PAIRED') {
        failProtocol(session, port);
        return;
      }
      if (envelope.requestId !== session.lastAcceptedFrameRequestId + 1
        || session.pendingRequests.size >= OVERLAY_MAX_PENDING_REQUESTS) {
        failProtocol(session, port);
        return;
      }
      session.lastAcceptedFrameRequestId = envelope.requestId;
      const record = {
        requestId: envelope.requestId,
        request: envelope.request,
        connectionEpoch: session.connectionEpoch,
        framePort: port,
        dispatched: false,
        timer: null,
      };
      session.pendingRequests.set(envelope.requestId, record);
      if (envelope.request.type === 'pinry:get-bootstrap'
        || envelope.request.type === 'pinry:get-job') {
        dispatchOverlayRequest(session, record);
      } else {
        authorizeOverlayRequest(session, record);
      }
    }

    function bindFirstEnvelopeDeadline(port, role) {
      let waitingForFirstEnvelope = true;
      let session = null;
      const deadline = setTimeoutImpl(() => {
        if (!waitingForFirstEnvelope) return;
        waitingForFirstEnvelope = false;
        releasePendingPort(port);
        disconnectBestEffort(port);
      }, OVERLAY_FIRST_ENVELOPE_TIMEOUT_MS);

      port.onDisconnect.addListener(() => {
        if (waitingForFirstEnvelope) {
          waitingForFirstEnvelope = false;
          releasePendingPort(port);
          clearTimeoutImpl(deadline);
          return;
        }
        if (!session || !isCurrentSession(session)) return;
        if (role === 'launcher' && session.launcherPort === port) {
          closeSession(session, 'CLOSED');
        } else if (role === 'frame' && session.framePort === port) {
          if (session.state === 'CLOSING') session.framePort = null;
          else beginFrameReconnect(session);
        }
      });
      port.onMessage.addListener((message) => {
        if (waitingForFirstEnvelope) {
          waitingForFirstEnvelope = false;
          releasePendingPort(port);
          clearTimeoutImpl(deadline);
          if (role === 'launcher') {
            session = registerLauncher(port, message);
          } else if (mayInspectClaim(port)) {
            session = claimFrame(port, message);
            if (!session) recordInvalidClaim(port);
          }
          if (!session) disconnectBestEffort(port);
          return;
        }
        if (!session) {
          disconnectBestEffort(port);
          return;
        }
        if (role === 'launcher') handleLauncherMessage(session, port, message);
        else handleFrameMessage(session, port, message);
      });
    }

    function handleConnect(port) {
      if (!port || port.name !== OVERLAY_LAUNCHER_PORT_NAME
        && port.name !== OVERLAY_FRAME_PORT_NAME) {
        disconnectBestEffort(port);
        return;
      }
      if (!port.onMessage || typeof port.onMessage.addListener !== 'function'
        || !port.onDisconnect || typeof port.onDisconnect.addListener !== 'function') {
        disconnectBestEffort(port);
        return;
      }
      if (!reservePendingPort(port)) {
        disconnectBestEffort(port);
        return;
      }
      bindFirstEnvelopeDeadline(
        port,
        port.name === OVERLAY_LAUNCHER_PORT_NAME ? 'launcher' : 'frame',
      );
    }

    function handleAlarm(alarm) {
      if (!alarm || alarm.name !== OVERLAY_CLEANUP_ALARM) return false;
      sweepExpiredSessions();
      return true;
    }

    async function ensureCleanupAlarm() {
      if (!chromeApi.alarms || typeof chromeApi.alarms.create !== 'function') {
        throw originApi.codeError('alarm_api_unavailable');
      }
      try {
        await optionalVoidCall(
          chromeApi.alarms.create,
          chromeApi.alarms,
          [OVERLAY_CLEANUP_ALARM, { periodInMinutes: 15 }],
          chromeApi.runtime,
        );
      } catch (_error) {
        throw originApi.codeError('alarm_schedule_failed');
      }
    }

    return { handleConnect, handleAlarm, ensureCleanupAlarm };
  }

  function isActive(value) {
    if (!value || value.schemaVersion !== 1) return false;
    if (typeof value.token !== 'string' || typeof value.username !== 'string') return false;
    if (typeof value.configurationId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(value.configurationId)) return false;
    try {
      return originApi.normalizeServerOrigin(value.origin) === value.origin;
    } catch (error) {
      return false;
    }
  }

  function isPending(value) {
    if (!value || value.schemaVersion !== 1) return false;
    if (typeof value.attemptId !== 'string' || value.attemptId === '') return false;
    if (value.phase !== 'validate' && value.phase !== 'rollback') return false;
    if (typeof value.allowInsecureHttp !== 'boolean') return false;
    if (typeof value.permissionWasPresent !== 'boolean') return false;
    if (typeof value.createdAt !== 'number') return false;
    if (value.phase === 'rollback') {
      if (Object.hasOwn(value, 'token')) return false;
      if (!Array.isArray(value.origins) || value.origins.length === 0) return false;
      try {
        return value.origins.every((origin, index) => (
          originApi.normalizeServerOrigin(origin) === origin
          && value.origins.indexOf(origin) === index
        ));
      } catch (error) {
        return false;
      }
    }
    if (typeof value.token !== 'string' || value.token === '') return false;
    try {
      return originApi.normalizeServerOrigin(value.origin) === value.origin;
    } catch (error) {
      return false;
    }
  }

  function sameActive(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  function sameActiveIdentity(left, right) {
    return Boolean(left && right
      && left.origin === right.origin
      && left.configurationId === right.configurationId
      && left.username === right.username);
  }

  function validateCreateBoardInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw originApi.codeError('invalid_board_request');
    }
    const keys = Object.keys(input).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['name', 'private'])) {
      throw originApi.codeError('invalid_board_request');
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 128 || typeof input.private !== 'boolean') {
      throw originApi.codeError('invalid_board_request');
    }
    return { name, private: input.private };
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function validateExpectedServerIdentity(value) {
    if (!isPlainObject(value)) {
      throw originApi.codeError('invalid_server_configuration');
    }
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['origin', 'username'])
      || typeof value.origin !== 'string'
      || typeof value.username !== 'string'
      || value.username === '') {
      throw originApi.codeError('invalid_server_configuration');
    }
    try {
      if (originApi.normalizeServerOrigin(value.origin) !== value.origin) {
        throw originApi.codeError('invalid_server_configuration');
      }
    } catch (_error) {
      throw originApi.codeError('invalid_server_configuration');
    }
    return Object.freeze({ origin: value.origin, username: value.username });
  }

  function validateCreateJobBoundaryInput(input) {
    if (!isPlainObject(input)) {
      throw originApi.codeError('invalid_server_configuration');
    }
    const keys = Object.keys(input).sort();
    if (JSON.stringify(keys)
      !== JSON.stringify(['candidates', 'expected_server', 'metadata', 'type'])) {
      throw originApi.codeError('invalid_server_configuration');
    }
    return {
      expectedServer: validateExpectedServerIdentity(input.expected_server),
      jobInput: { candidates: input.candidates, metadata: input.metadata },
    };
  }

  function projectJobForOverlay(job) {
    return {
      batch_id: job.batch_id,
      job_state: job.job_state,
      items: job.items.map((item) => ({
        status: item.status,
        retryable: item.retryable,
        error: item.error ? { code: item.error.code } : null,
      })),
      server_origin: job.server_origin,
      server_username: job.server_username,
    };
  }

  function createBackgroundController({
    chromeApi,
    fetchImpl = root.fetch && root.fetch.bind(root),
    now = Date.now,
    uuidFactory,
    setTimeoutImpl = root.setTimeout && root.setTimeout.bind(root),
    clearTimeoutImpl = root.clearTimeout && root.clearTimeout.bind(root),
  }) {
    const { runtime } = chromeApi;
    let pendingQueue = Promise.resolve();
    const resumeFlights = new Map();
    const activeRequests = new Map();
    const retryTimers = new Map();
    const sourceTabCreateQueues = new Map();
    const sourceTabCreatedInQueue = new Set();
    const pendingStages = new Set();

    function apiCall(method, receiver, args = []) {
      return originApi.callWebExtension(method, receiver, args, runtime);
    }

    async function storageGet(keys) {
      const result = await apiCall(
        chromeApi.storage.local.get,
        chromeApi.storage.local,
        [keys],
      );
      return result || {};
    }

    function storageSet(values) {
      return apiCall(chromeApi.storage.local.set, chromeApi.storage.local, [values]);
    }

    function storageRemove(keys) {
      return apiCall(chromeApi.storage.local.remove, chromeApi.storage.local, [keys]);
    }

    function storageBytes(keys) {
      if (!chromeApi.storage.local.getBytesInUse) return Promise.resolve(null);
      return apiCall(
        chromeApi.storage.local.getBytesInUse,
        chromeApi.storage.local,
        [keys],
      );
    }

    function alarmCreate(name, details) {
      if (!chromeApi.alarms || !chromeApi.alarms.create) {
        return Promise.reject(originApi.codeError('alarm_api_unavailable'));
      }
      return optionalVoidCall(
        chromeApi.alarms.create,
        chromeApi.alarms,
        [name, details],
        runtime,
      );
    }

    function alarmClear(name) {
      if (!chromeApi.alarms || !chromeApi.alarms.clear) return Promise.resolve(false);
      return apiCall(chromeApi.alarms.clear, chromeApi.alarms, [name]);
    }

    function alarmGet(name) {
      if (!chromeApi.alarms || !chromeApi.alarms.get) return Promise.resolve(null);
      return apiCall(chromeApi.alarms.get, chromeApi.alarms, [name]);
    }

    function containsOrigin(origin) {
      return apiCall(
        chromeApi.permissions.contains,
        chromeApi.permissions,
        [{ origins: [originApi.permissionPattern(origin)] }],
      );
    }

    function removeOrigin(origin) {
      return apiCall(
        chromeApi.permissions.remove,
        chromeApi.permissions,
        [{ origins: [originApi.permissionPattern(origin)] }],
      );
    }

    async function readActiveServer() {
      const stored = await storageGet(ACTIVE_KEY);
      const active = stored[ACTIVE_KEY];
      return isActive(active) ? Object.freeze({ ...active }) : null;
    }

    async function inspectActiveServer(snapshot) {
      let hasPermission;
      let permissionError;
      try {
        hasPermission = Boolean(await containsOrigin(snapshot.origin));
      } catch (error) {
        permissionError = error;
      }
      let active;
      let storageError;
      try {
        active = await readActiveServer();
      } catch (error) {
        storageError = error;
      }
      return {
        active, hasPermission, permissionError, storageError,
      };
    }

    async function readInitialPermission(snapshot) {
      const inspection = await inspectActiveServer(snapshot);
      if (!inspection.storageError
        && !sameActiveIdentity(inspection.active, snapshot)) {
        throw originApi.codeError('server_configuration_changed');
      }
      if (inspection.permissionError) throw inspection.permissionError;
      if (inspection.storageError) throw inspection.storageError;
      return inspection;
    }

    async function assertActiveUnchanged(snapshot) {
      const inspection = await inspectActiveServer(snapshot);
      const permissionChanged = !inspection.permissionError
        && !inspection.hasPermission;
      const configurationChanged = !inspection.storageError
        && !sameActiveIdentity(inspection.active, snapshot);
      if (permissionChanged || configurationChanged) {
        throw originApi.codeError('server_configuration_changed');
      }
      if (inspection.permissionError) throw inspection.permissionError;
      if (inspection.storageError) throw inspection.storageError;
      return inspection.active;
    }

    async function runCheckedServerRequest(snapshot, operation) {
      let result;
      let operationError;
      try {
        result = await operation();
      } catch (error) {
        operationError = error;
      }
      await assertActiveUnchanged(snapshot);
      if (operationError) throw operationError;
      return result;
    }

    async function readPending() {
      const stored = await storageGet(PENDING_KEY);
      const value = stored[PENDING_KEY];
      return isPending(value) ? value : null;
    }

    async function readOwned(attemptId, phase) {
      const current = await readPending();
      if (!current || current.attemptId !== attemptId || (phase && current.phase !== phase)) {
        throw originApi.codeError('attempt_replaced');
      }
      return current;
    }

    async function deleteOwned(attemptId, phase) {
      await readOwned(attemptId, phase);
      await storageRemove(PENDING_KEY);
    }

    function rollbackMarker(record, origins = [record.origin]) {
      return {
        schemaVersion: 1,
        attemptId: record.attemptId,
        phase: 'rollback',
        origins,
        allowInsecureHttp: origins.some((origin) => origin.startsWith('http://')),
        permissionWasPresent: false,
        createdAt: record.createdAt,
      };
    }

    async function transitionToRollback(record, origins = [record.origin]) {
      await readOwned(record.attemptId, 'validate');
      const marker = rollbackMarker(record, origins);
      await storageSet({ [PENDING_KEY]: marker });
      await readOwned(record.attemptId, 'rollback');
      return marker;
    }

    async function processRollback(record) {
      let marker = await readOwned(record.attemptId, 'rollback');
      while (marker.origins.length > 0) {
        const origin = marker.origins[0];
        try {
          await removeOrigin(origin);
        } catch (error) {
          throw originApi.codeError('permission_rollback_failed');
        }
        const current = await readOwned(marker.attemptId, 'rollback');
        if (current.origins[0] !== origin) throw originApi.codeError('attempt_replaced');
        if (current.origins.length === 1) {
          await deleteOwned(marker.attemptId, 'rollback');
          return { ok: true };
        }
        marker = { ...current, origins: current.origins.slice(1) };
        await storageSet({ [PENDING_KEY]: marker });
        marker = await readOwned(marker.attemptId, 'rollback');
      }
      return { ok: true };
    }

    async function restoreActive(previous, committed) {
      const stored = await storageGet(ACTIVE_KEY);
      if (!sameActive(stored[ACTIVE_KEY], committed)) return;
      if (previous) await storageSet({ [ACTIVE_KEY]: previous });
      else await storageRemove(ACTIVE_KEY);
    }

    async function failValidation(record, error) {
      const current = await readOwned(record.attemptId, 'validate');
      if (current.permissionWasPresent) {
        await deleteOwned(current.attemptId, 'validate');
        throw originApi.codeError(originApi.errorCode(error));
      }
      const marker = await transitionToRollback(current);
      await processRollback(marker);
      throw originApi.codeError(originApi.errorCode(error));
    }

    async function validatePending(record) {
      let current = await readOwned(record.attemptId, 'validate');
      if (current.origin.startsWith('http://') && current.allowInsecureHttp !== true) {
        return failValidation(
          current,
          originApi.codeError('insecure_http_confirmation_required'),
        );
      }
      let hasPermission = await containsOrigin(current.origin);
      current = await readOwned(record.attemptId, 'validate');
      if (!hasPermission) {
        return failValidation(current, originApi.codeError('host_permission_required'));
      }

      let profile;
      try {
        profile = await originApi.validateToken(current.origin, current.token, fetchImpl);
      } catch (error) {
        await readOwned(current.attemptId, 'validate');
        return failValidation(current, error);
      }
      current = await readOwned(current.attemptId, 'validate');

      hasPermission = await containsOrigin(current.origin);
      current = await readOwned(current.attemptId, 'validate');
      if (!hasPermission) {
        return failValidation(current, originApi.codeError('host_permission_required'));
      }

      const stored = await storageGet(ACTIVE_KEY);
      current = await readOwned(current.attemptId, 'validate');
      const previous = isActive(stored[ACTIVE_KEY]) ? stored[ACTIVE_KEY] : null;
      const committed = {
        schemaVersion: 1,
        origin: current.origin,
        token: current.token,
        username: profile.username,
        configurationId: current.attemptId,
        validatedAt: now(),
      };
      await storageSet({ [ACTIVE_KEY]: committed });
      try {
        current = await readOwned(current.attemptId, 'validate');
      } catch (error) {
        await restoreActive(previous, committed);
        throw error;
      }

      if (previous && previous.origin !== committed.origin) {
        const marker = await transitionToRollback(current, [previous.origin]);
        await processRollback(marker);
      } else {
        await deleteOwned(current.attemptId, 'validate');
      }
      return { ok: true };
    }

    async function processPendingOnce() {
      const current = await readPending();
      if (!current) return { ok: true };
      if (current.phase === 'rollback') return processRollback(current);
      return validatePending(current);
    }

    function processPending() {
      const currentRun = pendingQueue.catch(() => {}).then(processPendingOnce);
      pendingQueue = currentRun;
      return currentRun;
    }

    async function getServerState() {
      const current = await readActiveServer();
      if (!current) {
        return {
          configured: false,
          origin: null,
          username: null,
          hasPermission: false,
        };
      }
      const inspection = await readInitialPermission(current);
      return {
        configured: true,
        origin: inspection.active.origin,
        username: inspection.active.username,
        hasPermission: inspection.hasPermission,
      };
    }

    async function revalidateServer() {
      const current = await readActiveServer();
      if (!current) {
        return {
          configured: false,
          origin: null,
          username: null,
          hasPermission: false,
        };
      }

      const initial = await readInitialPermission(current);
      if (!initial.hasPermission) {
        return {
          configured: true,
          origin: initial.active.origin,
          username: initial.active.username,
          hasPermission: false,
        };
      }
      let profile;
      let validationError;
      try {
        profile = await originApi.validateToken(current.origin, current.token, fetchImpl);
      } catch (error) {
        validationError = error;
      }
      await assertActiveUnchanged(current);
      if (validationError) throw validationError;
      if (profile.username !== current.username) {
        throw originApi.codeError('server_identity_changed');
      }
      return {
        configured: true,
        origin: current.origin,
        username: current.username,
        hasPermission: true,
      };
    }

    function randomAttemptId() {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') {
        return root.crypto.randomUUID();
      }
      throw originApi.codeError('attempt_id_unavailable');
    }

    async function removeServer() {
      const stored = await storageGet([ACTIVE_KEY, PENDING_KEY]);
      const currentActive = isActive(stored[ACTIVE_KEY]) ? stored[ACTIVE_KEY] : null;
      const currentPending = isPending(stored[PENDING_KEY]) ? stored[PENDING_KEY] : null;
      const pendingOrigins = currentPending && currentPending.phase === 'rollback'
        ? currentPending.origins
        : [currentPending && currentPending.origin].filter(Boolean);
      const origins = [...new Set([
        currentActive && currentActive.origin,
        ...pendingOrigins,
      ].filter(Boolean))];

      if (origins.length === 0) {
        await storageRemove([ACTIVE_KEY, PENDING_KEY]);
        return { ok: true };
      }
      const marker = rollbackMarker({
        attemptId: randomAttemptId(),
        createdAt: now(),
      }, origins);
      await storageSet({ [PENDING_KEY]: marker });
      await storageRemove(ACTIVE_KEY);
      return processRollback(marker);
    }

    function jobKey(batchId) {
      return jobsApi.jobStorageKey(batchId);
    }

    function stageKey(batchId) {
      jobKey(batchId);
      return `${STAGED_JOB_PREFIX}${batchId}`;
    }

    function stageBatchId(key) {
      if (typeof key !== 'string' || !key.startsWith(STAGED_JOB_PREFIX)) return null;
      const batchId = key.slice(STAGED_JOB_PREFIX.length);
      try {
        return stageKey(batchId) === key ? batchId : null;
      } catch (_error) {
        return null;
      }
    }

    function stageMarker(batchId) {
      return { schema_version: 1, batch_id: batchId };
    }

    function isStageMarker(value, batchId) {
      return isPlainObject(value)
        && JSON.stringify(Object.keys(value).sort())
          === JSON.stringify(['batch_id', 'schema_version'])
        && value.schema_version === 1
        && value.batch_id === batchId;
    }

    async function readJob(batchId) {
      const key = jobKey(batchId);
      const markerKey = stageKey(batchId);
      if (pendingStages.has(batchId)) return null;
      const stored = await storageGet([key, markerKey]);
      if (pendingStages.has(batchId) || Object.hasOwn(stored, markerKey)) return null;
      return jobsApi.isJobSnapshot(stored[key]) ? stored[key] : null;
    }

    async function removeStagedPair(batchId) {
      await storageRemove(jobKey(batchId));
      await storageRemove(stageKey(batchId));
    }

    async function writeJob(job) {
      const key = jobKey(job.batch_id);
      if (!jobsApi.isJobSnapshot(job)) {
        throw originApi.codeError('invalid_job_transition');
      }
      try {
        const used = await storageBytes(null);
        const existing = await storageBytes(key);
        const encoded = JSON.stringify({ [key]: job });
        const size = root.TextEncoder
          ? new root.TextEncoder().encode(encoded).length
          : encoded.length;
        if ((used !== null || existing !== null)
          && (!Number.isFinite(used) || used < 0
            || !Number.isFinite(existing) || existing < 0)) {
          throw originApi.codeError('storage_write_failed');
        }
        if (Number.isFinite(used) && used - existing + size > 4 * 1024 * 1024) {
          throw originApi.codeError('storage_write_failed');
        }
      } catch (_error) {
        throw originApi.codeError('storage_write_failed');
      }
      try {
        await storageSet({ [key]: job });
      } catch (_error) {
        throw originApi.codeError('storage_write_failed');
      }
    }

    async function writeStagedJob(job, writeGuard) {
      const key = jobKey(job.batch_id);
      const markerKey = stageKey(job.batch_id);
      const marker = stageMarker(job.batch_id);
      if (!jobsApi.isJobSnapshot(job)) {
        throw originApi.codeError('invalid_job_transition');
      }
      try {
        const used = await storageBytes(null);
        const existing = await storageBytes([key, markerKey]);
        const encoded = JSON.stringify({ [key]: job, [markerKey]: marker });
        const size = root.TextEncoder
          ? new root.TextEncoder().encode(encoded).length
          : encoded.length;
        if ((used !== null || existing !== null)
          && (!Number.isFinite(used) || used < 0
            || !Number.isFinite(existing) || existing < 0)) {
          throw originApi.codeError('storage_write_failed');
        }
        if (Number.isFinite(used) && used - existing + size > 4 * 1024 * 1024) {
          throw originApi.codeError('storage_write_failed');
        }
      } catch (_error) {
        throw originApi.codeError('storage_write_failed');
      }

      await writeGuard();
      pendingStages.add(job.batch_id);
      try {
        await storageSet({ [key]: job, [markerKey]: marker });
      } catch (_error) {
        pendingStages.delete(job.batch_id);
        throw originApi.codeError('storage_write_failed');
      }

      try {
        await writeGuard();
      } catch (error) {
        try {
          await removeStagedPair(job.batch_id);
        } catch (_cleanupError) {
          // 남은 marker가 snapshot을 계속 격리한다.
        } finally {
          pendingStages.delete(job.batch_id);
        }
        throw error;
      }

      try {
        await storageRemove(markerKey);
      } catch (_error) {
        pendingStages.delete(job.batch_id);
        throw originApi.codeError('storage_write_failed');
      }
      try {
        await writeGuard();
      } catch (error) {
        try {
          await removeStagedPair(job.batch_id);
        } catch (_cleanupError) {
          try {
            await storageSet({ [markerKey]: marker });
          } catch (_quarantineError) {
            // 원래의 configuration 오류를 보존한다.
          }
        } finally {
          pendingStages.delete(job.batch_id);
        }
        throw error;
      }
      pendingStages.delete(job.batch_id);
    }

    async function quarantineAndReapStages(stored) {
      const staged = new Set();
      const reapCandidates = [];
      for (const [key, marker] of Object.entries(stored)) {
        const batchId = stageBatchId(key);
        if (batchId === null) continue;
        staged.add(batchId);
        if (!pendingStages.has(batchId) && isStageMarker(marker, batchId)) {
          reapCandidates.push({ batchId, key });
        }
      }
      for (const { batchId, key } of reapCandidates) {
        if (pendingStages.has(batchId)) continue;
        try {
          await storageRemove(jobKey(batchId));
          delete stored[jobKey(batchId)];
        } catch (_error) {
          continue;
        }
        try {
          await storageRemove(key);
          delete stored[key];
        } catch (_error) {
          // job 없는 marker도 닫힌 상태로 유지해 다음 정리 때 제거한다.
        }
      }
      return staged;
    }

    function sameReceipt(current, expected) {
      return current && current.batch_id === expected.batch_id
        && current.revision === expected.revision
        && JSON.stringify(current.active_client_item_ids)
          === JSON.stringify(expected.active_client_item_ids);
    }

    async function replaceOwnedJob(expected, replacement) {
      const current = await readJob(expected.batch_id);
      if (!sameReceipt(current, expected)) throw originApi.codeError('stale_job_revision');
      if (!jobsApi.isJobSnapshot(replacement)
        || replacement.batch_id !== current.batch_id
        || replacement.revision !== current.revision + 1) {
        throw originApi.codeError('invalid_job_transition');
      }
      await writeJob(replacement);
      return replacement;
    }

    function randomJobId() {
      if (uuidFactory) return uuidFactory();
      if (root.crypto && typeof root.crypto.randomUUID === 'function') {
        return root.crypto.randomUUID();
      }
      throw originApi.codeError('job_id_unavailable');
    }

    function clearRetryTimer(batchId) {
      if (!retryTimers.has(batchId)) return;
      if (clearTimeoutImpl) clearTimeoutImpl(retryTimers.get(batchId));
      retryTimers.delete(batchId);
    }

    async function clearRetry(batchId) {
      clearRetryTimer(batchId);
      await alarmClear(`${RETRY_ALARM_PREFIX}${batchId}`);
    }

    async function scheduleRetry(job) {
      const retryAt = jobsApi.nextRetryAt(job);
      if (retryAt === null) return;
      const alarmName = `${RETRY_ALARM_PREFIX}${job.batch_id}`;
      try {
        await alarmCreate(alarmName, { when: retryAt });
      } catch (_error) {
        throw originApi.codeError('alarm_schedule_failed');
      }
      clearRetryTimer(job.batch_id);
      const delay = Math.max(0, retryAt - now());
      if (delay < 30000 && setTimeoutImpl) {
        const timer = setTimeoutImpl(() => {
          retryTimers.delete(job.batch_id);
          resumeJob(job.batch_id);
        }, delay);
        retryTimers.set(job.batch_id, timer);
      }
    }

    function serverMatchesJob(current, job) {
      return isActive(current) && current.origin === job.server_origin
        && current.configurationId === job.server_configuration_id
        && current.username === job.server_username;
    }

    async function activeServerFor(job) {
      let stored = await storageGet(ACTIVE_KEY);
      let current = stored[ACTIVE_KEY];
      if (!serverMatchesJob(current, job)) {
        throw originApi.codeError('server_configuration_changed');
      }
      if (!await containsOrigin(current.origin)) {
        throw originApi.codeError('host_permission_required');
      }
      stored = await storageGet(ACTIVE_KEY);
      current = stored[ACTIVE_KEY];
      if (!serverMatchesJob(current, job)) {
        throw originApi.codeError('server_configuration_changed');
      }
      return current;
    }

    async function prepareChunk(batchId) {
      return jobsApi.withJobLock(batchId, async () => {
        let job = await readJob(batchId);
        if (!job || job.discard_requested || job.job_state === 'completed') return null;
        if (job.active_client_item_ids.length > 0) {
          const recovered = jobsApi.recoverInterruptedChunk(job, now);
          job = await replaceOwnedJob(job, recovered);
        }
        if (job.job_state === 'paused') return null;

        try {
          await activeServerFor(job);
        } catch (error) {
          const paused = jobsApi.pauseJob(job, originApi.errorCode(error), now);
          await replaceOwnedJob(job, paused);
          return null;
        }

        const eligible = { ...job, updated_at: now() };
        const chunk = jobsApi.nextChunk(eligible);
        if (chunk.length === 0) {
          if (jobsApi.nextRetryAt(job) !== null) {
            try {
              await scheduleRetry(job);
            } catch (error) {
              const paused = jobsApi.pauseJob(job, originApi.errorCode(error), now);
              await replaceOwnedJob(job, paused);
            }
          }
          return null;
        }
        const activeJob = jobsApi.activateChunk(
          job,
          chunk.map((item) => item.client_item_id),
          now,
        );
        await replaceOwnedJob(job, activeJob);
        return activeJob;
      });
    }

    function postOptions(job, token, signal) {
      const options = {
        method: 'POST',
        headers: {
          Authorization: `Token ${token}`,
          'Content-Type': 'application/json',
        },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        body: JSON.stringify(jobsApi.buildBatchRequest(job)),
      };
      if (signal) options.signal = signal;
      return options;
    }

    async function reservePostChunk(job) {
      return jobsApi.withJobLock(job.batch_id, async () => {
        const current = await readJob(job.batch_id);
        if (!sameReceipt(current, job) || current.discard_requested) {
          return { outcome: { code: 'stale_job_revision', pause: true } };
        }
        let server;
        try {
          server = await activeServerFor(job);
        } catch (error) {
          return { outcome: { code: originApi.errorCode(error), pause: true } };
        }
        const controller = root.AbortController ? new root.AbortController() : null;
        if (controller) activeRequests.set(job.batch_id, controller);
        let timeout = null;
        if (controller && setTimeoutImpl) {
          timeout = setTimeoutImpl(() => controller.abort(), 30000);
        }
        let request;
        try {
          request = fetchImpl(
            `${job.server_origin}/api/v2/pins/batch/`,
            postOptions(job, server.token, controller && controller.signal),
          );
        } catch (error) {
          request = Promise.reject(error);
        }
        return { controller, request, timeout };
      });
    }

    async function postChunk(job) {
      if (!jobsApi.isJobSnapshot(job) || job.active_client_item_ids.length === 0) {
        return { code: 'invalid_job_transition', pause: true };
      }
      const reservation = await reservePostChunk(job);
      if (reservation.outcome) return reservation.outcome;
      const { controller, request, timeout } = reservation;
      try {
        const response = await request;
        if (!response || response.redirected || (response.status >= 300 && response.status < 400)) {
          return { code: 'invalid_server_response', pause: true };
        }
        if (response.status === 429 || response.status >= 500) {
          return { code: 'temporary_server_error', retry: true };
        }
        if (!response.ok) {
          return { code: `http_${response.status}`, pause: true };
        }
        let envelope;
        try {
          envelope = await response.json();
          jobsApi.validateBatchEnvelope(envelope, job);
        } catch (_error) {
          return { code: 'invalid_server_response', pause: true };
        }
        return { envelope };
      } catch (_error) {
        return { code: 'network_error', retry: true };
      } finally {
        if (timeout !== null && clearTimeoutImpl) clearTimeoutImpl(timeout);
        if (activeRequests.get(job.batch_id) === controller) activeRequests.delete(job.batch_id);
      }
    }

    async function applyChunkOutcome(receipt, outcome) {
      return jobsApi.withJobLock(receipt.batch_id, async () => {
        const current = await readJob(receipt.batch_id);
        if (!sameReceipt(current, receipt) || current.discard_requested) return null;
        let replacement;
        if (outcome.envelope) {
          replacement = jobsApi.applyServerResults(current, outcome.envelope.results, now);
        } else {
          replacement = jobsApi.markActiveUnknown(current, outcome.code, now, {
            retry: Boolean(outcome.retry),
            pauseReason: outcome.pause ? outcome.code : null,
          });
        }
        await replaceOwnedJob(current, replacement);
        if (replacement.job_state === 'completed') {
          await clearRetry(replacement.batch_id);
        }
        return replacement;
      });
    }

    async function resumeLoop(batchId) {
      while (true) {
        const receipt = await prepareChunk(batchId);
        if (!receipt) return;
        const outcome = await postChunk(receipt);
        const updated = await applyChunkOutcome(receipt, outcome);
        if (!updated || updated.job_state !== 'running') return;
      }
    }

    function resumeJob(batchId) {
      try {
        jobKey(batchId);
      } catch (_error) {
        return Promise.reject(originApi.codeError('invalid_batch_id'));
      }
      if (resumeFlights.has(batchId)) return resumeFlights.get(batchId);
      const running = resumeLoop(batchId).catch(() => undefined);
      const tracked = running.finally(() => {
        if (resumeFlights.get(batchId) === tracked) resumeFlights.delete(batchId);
      });
      resumeFlights.set(batchId, tracked);
      return tracked;
    }

    function waitForJob(batchId) {
      return resumeFlights.get(batchId) || Promise.resolve();
    }

    function withSourceTabCreateLock(sourceTabId, callback) {
      const previous = sourceTabCreateQueues.get(sourceTabId);
      const queued = Boolean(previous);
      const running = (previous || Promise.resolve()).then(
        () => callback(queued),
        () => callback(queued),
      );
      const settled = running.then(() => undefined, () => undefined);
      sourceTabCreateQueues.set(sourceTabId, settled);
      settled.then(() => {
        if (sourceTabCreateQueues.get(sourceTabId) === settled) {
          sourceTabCreateQueues.delete(sourceTabId);
          sourceTabCreatedInQueue.delete(sourceTabId);
        }
      });
      return running;
    }

    async function createPinJobUnlocked(input, sourceTabId, queued, expectedServer = null) {
      let existing;
      try {
        existing = await currentJobForTab(sourceTabId);
      } catch (error) {
        if (originApi.errorCode(error) === 'webextension_api_error') {
          throw originApi.codeError('storage_write_failed');
        }
        throw error;
      }
      if (existing || (queued && sourceTabCreatedInQueue.has(sourceTabId))) {
        throw originApi.codeError('job_already_exists');
      }
      let server;
      if (expectedServer) {
        server = await readActiveServer();
        if (!server || server.origin !== expectedServer.origin
          || server.username !== expectedServer.username) {
          throw originApi.codeError('server_configuration_changed');
        }
      } else {
        const stored = await storageGet(ACTIVE_KEY);
        server = stored[ACTIVE_KEY];
      }
      if (!isActive(server)) throw originApi.codeError('server_not_configured');
      const initialPermission = expectedServer
        ? (await readInitialPermission(server)).hasPermission
        : await containsOrigin(server.origin);
      if (!initialPermission) {
        throw originApi.codeError('host_permission_required');
      }
      if (!input || !Array.isArray(input.candidates) || input.candidates.length === 0) {
        throw originApi.codeError('no_candidates');
      }
      const job = jobsApi.createJob({
        source_tab_id: sourceTabId,
        server_origin: server.origin,
        server_configuration_id: server.configurationId,
        server_username: server.username,
        candidates: input.candidates,
        metadata: input.metadata,
      }, randomJobId, now);
      if (expectedServer) {
        await writeStagedJob(job, () => assertActiveUnchanged(server));
      } else {
        await writeJob(job);
      }
      sourceTabCreatedInQueue.add(sourceTabId);
      resumeJob(job.batch_id);
      return { batch_id: job.batch_id };
    }

    function createPinJob(input, sourceTabId, expectedServer = null) {
      if (!Number.isInteger(sourceTabId) || sourceTabId < 0) {
        return Promise.reject(originApi.codeError('invalid_sender'));
      }
      if (input && Array.isArray(input.candidates)
        && input.candidates.length > jobsApi.MAX_CANDIDATES) {
        return Promise.reject(originApi.codeError('too_many_candidates'));
      }
      return withSourceTabCreateLock(
        sourceTabId,
        (queued) => createPinJobUnlocked(input, sourceTabId, queued, expectedServer),
      );
    }

    function createJobBoundary(sourceTabId, input) {
      let validated;
      try {
        validated = validateCreateJobBoundaryInput(input);
      } catch (error) {
        return Promise.reject(error);
      }
      return createPinJob(validated.jobInput, sourceTabId, validated.expectedServer);
    }

    async function getJob(batchId) {
      const job = await readJob(batchId);
      if (!job) throw originApi.codeError('job_not_found');
      return job;
    }

    async function discardJob(batchId, sourceTabId = null) {
      return jobsApi.withJobLock(batchId, async () => {
        const current = await readJob(batchId);
        if (!current) return { ok: true };
        if (sourceTabId !== null && (!Number.isSafeInteger(sourceTabId)
          || sourceTabId < 0 || current.source_tab_id !== sourceTabId)) {
          throw originApi.codeError('invalid_sender');
        }
        const tombstone = jobsApi.tombstoneJob(current, now);
        await replaceOwnedJob(current, tombstone);
        const request = activeRequests.get(batchId);
        if (request) request.abort();
        try {
          await storageRemove(jobKey(batchId));
        } catch (_error) {
          return { ok: true, cleanup_pending: true };
        }
        await clearRetry(batchId);
        return { ok: true };
      });
    }

    async function retryDiscardRemoval(batchId) {
      return jobsApi.withJobLock(batchId, async () => {
        const current = await readJob(batchId);
        if (!current || current.discard_requested !== true) return false;
        try {
          await storageRemove(jobKey(batchId));
          await clearRetry(batchId);
          return true;
        } catch (_error) {
          return false;
        }
      });
    }

    async function retryJob(batchId, sourceTabId = null) {
      await jobsApi.withJobLock(batchId, async () => {
        let current = await readJob(batchId);
        if (!current) throw originApi.codeError('job_not_found');
        if (sourceTabId !== null && (!Number.isSafeInteger(sourceTabId)
          || sourceTabId < 0 || current.source_tab_id !== sourceTabId)) {
          throw originApi.codeError('invalid_sender');
        }
        if (current.discard_requested === true) {
          throw originApi.codeError('job_discarded');
        }
        if (current.active_client_item_ids.length > 0) {
          const recovered = jobsApi.recoverInterruptedChunk(current, now);
          current = await replaceOwnedJob(current, recovered);
        }
        const retried = jobsApi.retryJobItems(current, now);
        await replaceOwnedJob(current, retried);
        const request = activeRequests.get(batchId);
        if (request) request.abort();
      });
      const existing = resumeFlights.get(batchId);
      if (existing) existing.then(() => resumeJob(batchId));
      else resumeJob(batchId);
      return { ok: true };
    }

    async function getJobForTab(sourceTabId, batchId) {
      const job = await getJob(batchId);
      if (!Number.isSafeInteger(sourceTabId) || sourceTabId < 0
        || job.source_tab_id !== sourceTabId) {
        throw originApi.codeError('invalid_sender');
      }
      return job;
    }

    function retryJobForTab(sourceTabId, batchId) {
      return retryJob(batchId, sourceTabId);
    }

    function discardJobForTab(sourceTabId, batchId) {
      return discardJob(batchId, sourceTabId);
    }

    async function recoverJobs() {
      const stored = await storageGet(null);
      const staged = await quarantineAndReapStages(stored);
      const jobs = Object.entries(stored)
        .filter(([key, value]) => key.startsWith(JOB_PREFIX) && jobsApi.isJobSnapshot(value)
          && key === jobKey(value.batch_id) && !staged.has(value.batch_id))
        .map(([, value]) => value);
      const tombstones = jobs.filter((job) => job.discard_requested === true);
      const resumable = jobs.filter((job) => job.discard_requested !== true);
      await Promise.all(tombstones.map((job) => retryDiscardRemoval(job.batch_id)));
      for (const job of resumable) resumeJob(job.batch_id);
      await Promise.all(resumable.map((job) => waitForJob(job.batch_id)));
      return { ok: true };
    }

    function completedForCleanup(job, threshold) {
      if (job.job_state !== 'completed' || job.active_client_item_ids.length !== 0
        || !Number.isFinite(job.completed_at) || job.completed_at > threshold) {
        return false;
      }
      return job.items.every((item) => item.status === 'created'
        || item.status === 'replayed'
        || (item.status === 'failed' && item.retryable === false)
        || (item.status === 'conflict' && item.retryable === false));
    }

    async function cleanupJobs() {
      const stored = await storageGet(null);
      const staged = await quarantineAndReapStages(stored);
      const threshold = now() - CLEANUP_AGE_MS;
      const tombstones = Object.entries(stored)
        .filter(([key, value]) => key.startsWith(JOB_PREFIX)
          && jobsApi.isJobSnapshot(value)
          && key === jobKey(value.batch_id)
          && !staged.has(value.batch_id)
          && value.discard_requested === true)
        .map(([, value]) => value.batch_id);
      for (const batchId of tombstones) await retryDiscardRemoval(batchId);
      const candidates = Object.entries(stored)
        .filter(([key, value]) => key.startsWith(JOB_PREFIX)
          && jobsApi.isJobSnapshot(value)
          && key === jobKey(value.batch_id)
          && !staged.has(value.batch_id)
          && completedForCleanup(value, threshold))
        .map(([, value]) => value.batch_id);
      for (const batchId of candidates) {
        await jobsApi.withJobLock(batchId, async () => {
          const current = await readJob(batchId);
          if (!current || !completedForCleanup(current, threshold)) return;
          const marker = jobsApi.markCleanupJob(current, now);
          try {
            await replaceOwnedJob(current, marker);
            await storageRemove(jobKey(batchId));
            await clearRetry(batchId);
          } catch (_error) {
            // Durable marker is retained for the next cleanup pass.
          }
        });
      }
      return { ok: true };
    }

    async function handleAlarm(alarm) {
      const name = alarm && alarm.name;
      if (name === CLEANUP_ALARM) {
        await cleanupJobs();
        return true;
      }
      if (typeof name !== 'string' || !name.startsWith(RETRY_ALARM_PREFIX)) return false;
      const batchId = name.slice(RETRY_ALARM_PREFIX.length);
      try {
        if (`${RETRY_ALARM_PREFIX}${jobKey(batchId).slice(JOB_PREFIX.length)}` !== name) {
          return false;
        }
      } catch (_error) {
        return false;
      }
      await resumeJob(batchId);
      return true;
    }

    async function ensureCleanupAlarm() {
      const existing = await alarmGet(CLEANUP_ALARM);
      if (existing && existing.name === CLEANUP_ALARM
        && existing.periodInMinutes === 24 * 60
        && Number.isFinite(existing.scheduledTime) && existing.scheduledTime > 0) {
        return;
      }
      await alarmCreate(CLEANUP_ALARM, { periodInMinutes: 24 * 60 });
    }

    function bootstrapFetchOptions(token) {
      return {
        method: 'GET',
        headers: { Authorization: `Token ${token}` },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      };
    }

    async function fetchBootstrapJson(url, server) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch (_error) {
        throw originApi.codeError('invalid_server_response');
      }
      if (parsed.origin !== server.origin) {
        throw originApi.codeError('invalid_server_response');
      }
      let response;
      try {
        response = await fetchImpl(parsed.href, bootstrapFetchOptions(server.token));
      } catch (_error) {
        throw originApi.codeError('network_error');
      }
      if (!response || !response.ok || response.redirected) {
        throw originApi.codeError('invalid_server_response');
      }
      try {
        return await response.json();
      } catch (_error) {
        throw originApi.codeError('invalid_server_response');
      }
    }

    async function currentJobForTab(sourceTabId) {
      if (!Number.isInteger(sourceTabId) || sourceTabId < 0) return null;
      const used = await storageBytes(null);
      if (Number.isFinite(used) && used > MAX_CURRENT_JOB_SCAN_BYTES) {
        throw originApi.codeError('job_scan_limit_exceeded');
      }
      const stored = await storageGet(null);
      const candidates = [];
      let scanned = 0;
      for (const [key, value] of Object.entries(stored)) {
        if (!key.startsWith(JOB_PREFIX)) continue;
        scanned += 1;
        if (scanned > MAX_CURRENT_JOB_SCAN) {
          throw originApi.codeError('job_scan_limit_exceeded');
        }
        if (!jobsApi.isJobSnapshot(value) || key !== jobKey(value.batch_id)
          || Object.hasOwn(stored, stageKey(value.batch_id))
          || pendingStages.has(value.batch_id)
          || value.source_tab_id !== sourceTabId || value.discard_requested
          || (value.job_state !== 'running' && value.job_state !== 'paused')) continue;
        candidates.push(value);
      }
      candidates.sort((left, right) => (
        right.updated_at - left.updated_at
        || right.revision - left.revision
        || (left.batch_id < right.batch_id ? 1 : (left.batch_id > right.batch_id ? -1 : 0))
      ));
      return candidates[0] || null;
    }

    function summarizeJob(job) {
      if (!job) return null;
      return {
        batch_id: job.batch_id,
        job_state: job.job_state,
        paused_reason: job.paused_reason,
        revision: job.revision,
        updated_at: job.updated_at,
        items: job.items.map((item) => ({
          status: item.status,
          error: item.error ? { code: item.error.code } : null,
        })),
      };
    }

    async function getBootstrap(sourceTabId) {
      const currentJob = await currentJobForTab(sourceTabId);
      if (currentJob) resumeJob(currentJob.batch_id);
      const currentJobSummary = summarizeJob(currentJob);
      const server = await readActiveServer();
      if (!server) {
        return {
          configured: false,
          origin: null,
          username: null,
          hasPermission: false,
          boards: [],
          tags: [],
          current_job: currentJobSummary,
        };
      }
      const initial = await readInitialPermission(server);
      if (!initial.hasPermission) {
        return {
          configured: true,
          origin: initial.active.origin,
          username: initial.active.username,
          hasPermission: false,
          boards: [],
          tags: [],
          current_job: currentJobSummary,
        };
      }

      const firstPath = `/api/v2/boards/?submitter__username=${encodeURIComponent(server.username)}`
        + '&limit=100&offset=0';
      let nextUrl = new URL(firstPath, server.origin).href;
      const seen = new Set();
      const boards = [];
      let pages = 0;
      while (nextUrl !== null) {
        let canonical;
        try {
          canonical = new URL(nextUrl, server.origin);
        } catch (_error) {
          throw originApi.codeError('invalid_server_response');
        }
        if (canonical.origin !== server.origin || seen.has(canonical.href) || pages >= 50) {
          throw originApi.codeError('invalid_server_response');
        }
        seen.add(canonical.href);
        pages += 1;
        const page = await runCheckedServerRequest(server, async () => {
          const fetched = await fetchBootstrapJson(canonical.href, server);
          if (!fetched || !Array.isArray(fetched.results)
            || !fetched.results.every((board) => board && Number.isInteger(board.id)
              && typeof board.name === 'string')
            || boards.length + fetched.results.length > 5000) {
            throw originApi.codeError('invalid_server_response');
          }
          return fetched;
        });
        boards.push(...page.results.map((board) => ({ id: board.id, name: board.name })));
        if (page.next === null) nextUrl = null;
        else if (typeof page.next === 'string' && page.next !== '') {
          try {
            nextUrl = new URL(page.next, canonical.href).href;
          } catch (_error) {
            throw originApi.codeError('invalid_server_response');
          }
        } else {
          throw originApi.codeError('invalid_server_response');
        }
      }

      const tags = await runCheckedServerRequest(server, async () => {
        const tagData = await fetchBootstrapJson(
          new URL('/api/v2/tags-auto-complete/', server.origin).href,
          server,
        );
        const tagValues = Array.isArray(tagData)
          ? tagData : tagData && (tagData.results || tagData.tags);
        if (!Array.isArray(tagValues)) throw originApi.codeError('invalid_server_response');
        const values = tagValues.map(
          (tag) => (typeof tag === 'string' ? tag : tag && tag.name),
        );
        if (!values.every((tag) => typeof tag === 'string') || values.length > 5000) {
          throw originApi.codeError('invalid_server_response');
        }
        return values;
      });
      return {
        configured: true,
        origin: server.origin,
        username: server.username,
        hasPermission: true,
        boards,
        tags,
        current_job: currentJobSummary,
      };
    }

    async function createBoard(input, expectedServer = null) {
      const board = validateCreateBoardInput(input);
      const expected = expectedServer === null
        ? null : validateExpectedServerIdentity(expectedServer);
      const server = await readActiveServer();
      if (!server) throw originApi.codeError('server_not_configured');
      if (expected && (server.origin !== expected.origin
        || server.username !== expected.username)) {
        throw originApi.codeError('server_configuration_changed');
      }
      const initial = await readInitialPermission(server);
      if (!initial.hasPermission) {
        throw originApi.codeError('host_permission_required');
      }

      return runCheckedServerRequest(server, async () => {
        let response;
        try {
          response = await fetchImpl(`${server.origin}/api/v2/boards/`, {
            method: 'POST',
            headers: {
              Authorization: `Token ${server.token}`,
              'Content-Type': 'application/json',
            },
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            body: JSON.stringify(board),
          });
        } catch (_error) {
          throw originApi.codeError('network_error');
        }
        if (!response || !response.ok || response.status !== 201 || response.redirected) {
          throw originApi.codeError('invalid_server_response');
        }
        if (typeof response.url !== 'string' || response.url === '') {
          throw originApi.codeError('invalid_server_response');
        }
        let responseOrigin;
        try {
          responseOrigin = new URL(response.url).origin;
        } catch (_error) {
          throw originApi.codeError('invalid_server_response');
        }
        if (responseOrigin !== server.origin) {
          throw originApi.codeError('invalid_server_response');
        }

        let created;
        try {
          created = await response.json();
        } catch (_error) {
          throw originApi.codeError('invalid_server_response');
        }
        if (!created || !isSafePositiveInteger(created.id)
          || typeof created.name !== 'string'
          || utf8ByteLength(created.name) > OVERLAY_MAX_TAG_BYTES) {
          throw originApi.codeError('invalid_server_response');
        }
        return { id: created.id, name: created.name };
      });
    }

    async function openOptions() {
      await apiCall(chromeApi.runtime.openOptionsPage, chromeApi.runtime);
      return { ok: true };
    }

    return {
      createBoard,
      createPinJob,
      cleanupJobs,
      createJobBoundary,
      discardJob,
      discardJobForTab,
      getBootstrap,
      getJob,
      getJobForTab,
      getServerState,
      handleAlarm,
      ensureCleanupAlarm,
      openOptions,
      processPending,
      recoverJobs,
      revalidateServer,
      removeServer,
      resumeJob,
      retryJob,
      retryJobForTab,
      waitForJob,
    };
  }

  function createRuntimeMessageHandler(controller, chromeApi) {
    return function handleRuntimeMessage(message, sender, sendResponse) {
      const messageType = message && typeof message.type === 'string' ? message.type : '';
      const jobMessage = messageType === 'pinry:get-job'
        || messageType === 'pinry:retry-job'
        || messageType === 'pinry:discard-job';
      const senderType = jobMessage || messageType === 'pinry:get-bootstrap'
        ? 'pinry:create-job' : messageType;
      if (!originApi.isAllowedSender(senderType, sender, chromeApi.runtime)) return false;

      let operation;
      if (messageType === 'pinry:validate-pending-server') operation = controller.processPending();
      else if (messageType === 'pinry:remove-server') operation = controller.removeServer();
      else if (messageType === 'pinry:get-server-state') {
        operation = controller.getServerState().then((state) => ({ ok: true, state }));
      } else if (messageType === 'pinry:revalidate-server') {
        operation = controller.revalidateServer().then((state) => ({ ok: true, state }));
      } else if (messageType === 'pinry:get-bootstrap') {
        operation = controller.getBootstrap(sender.tab.id).then((bootstrap) => ({ bootstrap }));
      } else if (messageType === 'pinry:create-board') {
        const keys = Object.keys(message).sort();
        if (JSON.stringify(keys) !== JSON.stringify(['name', 'private', 'type'])) {
          operation = Promise.reject(originApi.codeError('invalid_board_request'));
        } else {
          operation = controller.createBoard({ name: message.name, private: message.private });
        }
      } else if (messageType === 'pinry:create-job') {
        operation = controller.createJobBoundary(sender.tab.id, message);
      }
      else if (jobMessage) {
        operation = controller.getJob(message.batch_id).then((job) => {
          if (!originApi.isAllowedSender(messageType, sender, chromeApi.runtime, job)) {
            throw originApi.codeError('invalid_sender');
          }
          if (messageType === 'pinry:get-job') return { job: projectJobForOverlay(job) };
          if (messageType === 'pinry:retry-job') return controller.retryJob(message.batch_id);
          return controller.discardJob(message.batch_id);
        });
      }
      else if (messageType === 'pinry:open-options') operation = controller.openOptions();
      else return false;

      Promise.resolve(operation).then(
        (response) => sendResponse(response && response.ok === true
          ? response : { ok: true, ...(response || {}) }),
        (error) => {
          const code = originApi.errorCode(error);
          if (messageType === 'pinry:get-bootstrap') {
            sendResponse({
              ok: false,
              code,
              retryable: code === 'network_error'
                || code === 'host_permission_required'
                || code === 'webextension_api_error',
            });
          } else {
            sendResponse({ ok: false, code });
          }
        },
      );
      return true;
    };
  }

  function executeOverlayLauncher(chromeApi, tab) {
    if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0) {
      return Promise.resolve(false);
    }
    return originApi.callWebExtension(
      chromeApi.scripting.executeScript,
      chromeApi.scripting,
      [{
        target: { tabId: tab.id, frameIds: [0] },
        files: ['candidates.js', 'launcher.js'],
      }],
      chromeApi.runtime,
    ).then(() => true);
  }

  function updateContextMenu(chromeApi) {
    chromeApi.storage.local.get('contextMenu', (stored) => {
      chromeApi.contextMenus.removeAll(() => {
        if (!stored || stored.contextMenu !== false) {
          chromeApi.contextMenus.create({
            id: 'addToPinry',
            title: 'SVRx Pinry에 이미지 추가',
            contexts: ['page', 'selection', 'link', 'editable', 'image', 'video', 'audio'],
          });
        }
      });
    });
  }

  function registerBackground(chromeApi) {
    const controller = createBackgroundController({ chromeApi });
    const requestHandler = createOverlayRequestHandler(controller);
    const overlayManager = createOverlaySessionManager({
      chromeApi,
      requestHandler,
    });
    chromeApi.action.onClicked.addListener((tab) => {
      executeOverlayLauncher(chromeApi, tab).catch(() => {});
    });
    chromeApi.contextMenus.onClicked.addListener((info, tab) => {
      if (info.menuItemId === 'addToPinry') {
        executeOverlayLauncher(chromeApi, tab).catch(() => {});
      }
    });
    chromeApi.runtime.onMessage.addListener(createRuntimeMessageHandler(controller, chromeApi));
    chromeApi.runtime.onConnect.addListener(overlayManager.handleConnect);
    if (chromeApi.alarms && chromeApi.alarms.onAlarm) {
      chromeApi.alarms.onAlarm.addListener((alarm) => {
        if (!overlayManager.handleAlarm(alarm)) controller.handleAlarm(alarm).catch(() => {});
      });
    }
    overlayManager.ensureCleanupAlarm().catch(() => {});
    if (chromeApi.runtime.onStartup) {
      chromeApi.runtime.onStartup.addListener(() => {
        controller.processPending().catch(() => {});
        controller.recoverJobs().catch(() => {});
        controller.ensureCleanupAlarm().catch(() => {});
      });
    }
    if (chromeApi.storage.onChanged) {
      chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes.contextMenu) updateContextMenu(chromeApi);
      });
    }
    updateContextMenu(chromeApi);
    controller.processPending().catch(() => {});
    controller.recoverJobs().catch(() => {});
    controller.ensureCleanupAlarm().catch(() => {});
    return controller;
  }

  return {
    createBackgroundController,
    createOverlayRequestHandler,
    createOverlaySessionManager,
    createRuntimeMessageHandler,
    generateConnectionEpoch,
    projectOverlayFailure,
    projectOverlaySuccess,
    registerBackground,
    validateOverlayCandidateState,
    validateOverlayClaimEnvelope,
    validateOverlayFrameEnvelope,
    validateOverlayLauncherEnvelope,
    validateOverlayPageDefaults,
    validateOverlayRegisterEnvelope,
    validateOverlayRequest,
  };
}));
