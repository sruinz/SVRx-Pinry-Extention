(function (root, factory) {
  const api = factory(root);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PinryJobs = api;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, (root) => {
  'use strict';

  const MAX_CANDIDATES = 500;
  const MAX_CHUNK_SIZE = 3;
  const MAX_ITEM_URL_BYTES = 16 * 1024;
  const MAX_METADATA_STRING_BYTES = 64 * 1024;
  const MAX_TAG_BYTES = 4 * 1024;
  const MAX_JOB_BYTES = 1024 * 1024;
  const RETRY_DELAYS = [1, 2, 4, 8, 16, 30];
  const MAX_AUTO_ATTEMPTS = RETRY_DELAYS.length;
  const FINAL_ATTEMPT = MAX_AUTO_ATTEMPTS + 1;
  const MAX_PERSISTED_REVISION = Number.MAX_SAFE_INTEGER - 1;
  const SAFE_SERVER_RETRYABILITY = Object.freeze({
    batch_deadline_exceeded: true,
    in_progress: true,
    idempotency_mismatch: false,
    pin_permanently_deleted: false,
    lease_lost: true,
    board_access_changed: false,
    database_busy: true,
    internal_error: false,
    unsupported_http_stack: false,
    invalid_url_policy: false,
    blocked_address: false,
    dns_rebinding_detected: false,
    too_many_redirects: false,
    image_download_failed: null,
    image_fetch_timeout: true,
    unsupported_content_encoding: false,
    image_too_large: false,
    image_too_many_pixels: false,
    invalid_image_content: false,
    unsupported_image_format: false,
    image_processing_timeout: true,
    media_path_conflict: false,
    image_processing_failed: false,
    media_configuration_error: false,
    media_publish_changed: false,
    media_storage_failed: true,
    media_storage_unsupported: false,
  });
  const JOB_STATES = new Set(['running', 'paused', 'completed']);
  const ITEM_STATUSES = new Set([
    'pending', 'created', 'replayed', 'failed', 'conflict', 'unknown',
  ]);
  const WORKER_ITEM_RETRYABILITY = Object.freeze({
    worker_interrupted: true,
    network_error: true,
    temporary_server_error: true,
    invalid_server_response: false,
    server_configuration_changed: false,
    host_permission_required: false,
  });
  const PAUSED_REASONS = new Set([
    'alarm_schedule_failed', 'discard_requested', 'host_permission_required',
    'invalid_server_response', 'retry_exhausted', 'server_configuration_changed',
  ]);
  const locks = new Map();

  function codedError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function byteLength(value) {
    if (root.TextEncoder) {
      return new root.TextEncoder().encode(value).length;
    }
    return unescape(encodeURIComponent(value)).length;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function hasExactKeys(value, expected) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    return actual.length === expected.length
      && actual.every((key, index) => key === [...expected].sort()[index]);
  }

  function isSafeId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  }

  function isFiniteTime(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }

  function transitionTimestamp(job, now) {
    const timestamp = now();
    if (!isFiniteTime(timestamp) || !isFiniteTime(job.updated_at)) {
      throw codedError('invalid_job_transition');
    }
    return Math.max(job.updated_at, timestamp);
  }

  function nextRevision(job) {
    if (!Number.isSafeInteger(job.revision) || job.revision < 1
      || job.revision >= MAX_PERSISTED_REVISION) {
      throw codedError('invalid_job_transition');
    }
    return job.revision + 1;
  }

  function validateUrl(url) {
    if (typeof url !== 'string' || byteLength(url) > MAX_ITEM_URL_BYTES) {
      throw codedError('job_too_large');
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      throw codedError('invalid_candidate_url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw codedError('invalid_candidate_url');
    }
    if (parsed.username || parsed.password || parsed.hash || parsed.href !== url) {
      throw codedError('invalid_candidate_url');
    }
  }

  function validateServerOrigin(origin) {
    validateUrl(`${origin}/`);
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw codedError('invalid_server_origin');
    }
  }

  function validateMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || !hasExactKeys(metadata, [
        'board_ids', 'description', 'private', 'referer', 'tags',
      ])
      || !Array.isArray(metadata.board_ids) || !metadata.board_ids.every(Number.isInteger)
      || !Array.isArray(metadata.tags) || !metadata.tags.every((tag) => typeof tag === 'string')
      || typeof metadata.private !== 'boolean'
      || typeof metadata.referer !== 'string'
      || typeof metadata.description !== 'string') {
      throw codedError('invalid_job_metadata');
    }
    if (byteLength(metadata.referer) > MAX_METADATA_STRING_BYTES
      || byteLength(metadata.description) > MAX_METADATA_STRING_BYTES
      || metadata.tags.length > MAX_CANDIDATES
      || metadata.board_ids.length > MAX_CANDIDATES
      || metadata.tags.some((tag) => byteLength(tag) > MAX_TAG_BYTES)) {
      throw codedError('job_too_large');
    }
  }

  function createJob(input, uuidFactory, now) {
    if (!input || !Array.isArray(input.candidates) || input.candidates.length === 0) {
      throw codedError('no_candidates');
    }
    if (input.candidates.length > MAX_CANDIDATES) {
      throw codedError('too_many_candidates');
    }
    if (!Number.isInteger(input.source_tab_id) || input.source_tab_id < 0) {
      throw codedError('invalid_source_tab');
    }
    if (!isSafeId(input.server_configuration_id)
      || typeof input.server_username !== 'string' || input.server_username === ''
      || byteLength(input.server_username) > MAX_TAG_BYTES) {
      throw codedError('invalid_server_configuration');
    }
    validateMetadata(input.metadata);
    validateServerOrigin(input.server_origin);
    input.candidates.forEach((candidate) => {
      if (!candidate || typeof candidate !== 'object') {
        throw codedError('invalid_candidate_url');
      }
      validateUrl(candidate.url);
    });

    const batchId = uuidFactory();
    const ids = new Set();
    const timestamp = now();
    const items = input.candidates.map((candidate) => {
      const clientItemId = uuidFactory();
      if (typeof clientItemId !== 'string' || clientItemId.length === 0 || ids.has(clientItemId)) {
        throw codedError('invalid_client_item_id');
      }
      ids.add(clientItemId);
      return {
        client_item_id: clientItemId,
        url: candidate.url,
        status: 'pending',
        retryable: true,
        retry_after_at: null,
        attempt_count: 0,
        error: null,
        pin_id: null,
      };
    });
    const job = {
      schema_version: 1,
      batch_id: batchId,
      source_tab_id: input.source_tab_id,
      server_origin: input.server_origin,
      server_configuration_id: input.server_configuration_id,
      server_username: input.server_username,
      job_state: 'running',
      paused_reason: null,
      revision: 1,
      metadata: clone(input.metadata),
      items,
      active_client_item_ids: [],
      created_at: timestamp,
      updated_at: timestamp,
      completed_at: null,
    };
    if (byteLength(JSON.stringify(job)) > MAX_JOB_BYTES) {
      throw codedError('job_too_large');
    }
    return job;
  }

  function isTerminal(item) {
    return item.status === 'created' || item.status === 'replayed'
      || (item.status === 'failed' && item.retryable === false)
      || (item.status === 'conflict' && item.retryable === false);
  }

  function isReady(item, timestamp) {
    return !isTerminal(item) && item.retryable === true
      && (item.retry_after_at === null || item.retry_after_at <= timestamp);
  }

  function nextChunk(job) {
    if (job.job_state !== 'running' || job.active_client_item_ids.length > 0) {
      return [];
    }
    return job.items.filter((item) => isReady(item, job.updated_at)).slice(0, MAX_CHUNK_SIZE);
  }

  function activateChunk(job, clientItemIds, now) {
    if (!Array.isArray(clientItemIds) || clientItemIds.length === 0
      || clientItemIds.length > MAX_CHUNK_SIZE || job.active_client_item_ids.length > 0) {
      throw codedError('invalid_job_transition');
    }
    const timestamp = transitionTimestamp(job, now);
    const requested = new Set(clientItemIds);
    if (requested.size !== clientItemIds.length
      || !job.items.filter((item) => requested.has(item.client_item_id))
        .every((item) => isReady(item, timestamp) && item.attempt_count < FINAL_ATTEMPT)) {
      throw codedError('invalid_job_transition');
    }
    if (job.items.filter((item) => requested.has(item.client_item_id)).length !== requested.size) {
      throw codedError('invalid_job_transition');
    }
    const updated = clone(job);
    updated.items.forEach((item) => {
      if (requested.has(item.client_item_id)) {
        item.status = 'pending';
        item.retryable = true;
        item.attempt_count += 1;
        item.retry_after_at = null;
        item.error = null;
        item.pin_id = null;
      }
    });
    updated.active_client_item_ids = [...clientItemIds];
    updated.revision = nextRevision(job);
    updated.updated_at = timestamp;
    return updated;
  }

  function validResult(result) {
    if (!isPlainObject(result) || !isSafeId(result.client_item_id)) {
      return false;
    }
    if (result.status === 'created' || result.status === 'replayed') {
      return hasExactKeys(result, ['client_item_id', 'pin_id', 'status'])
        && Number.isInteger(result.pin_id) && result.pin_id > 0;
    }
    if (result.status !== 'failed' && result.status !== 'conflict') return false;
    if (!hasExactKeys(result, ['client_item_id', 'error', 'status'])) return false;
    const error = result.error;
    if (!isPlainObject(error) || typeof error.code !== 'string'
      || !Object.hasOwn(SAFE_SERVER_RETRYABILITY, error.code)
      || typeof error.message !== 'string' || byteLength(error.message) > MAX_METADATA_STRING_BYTES
      || typeof error.retryable !== 'boolean') return false;
    const hasDelay = Object.hasOwn(error, 'retry_after_seconds');
    if (!hasExactKeys(error, hasDelay
      ? ['code', 'message', 'retry_after_seconds', 'retryable']
      : ['code', 'message', 'retryable'])) return false;
    const fixedRetryable = SAFE_SERVER_RETRYABILITY[error.code];
    if (fixedRetryable !== null && error.retryable !== fixedRetryable) return false;
    const expectedStatus = error.code === 'in_progress'
      || error.code === 'idempotency_mismatch' || error.code === 'lease_lost'
      ? 'conflict' : 'failed';
    if (result.status !== expectedStatus) return false;
    if (error.code === 'in_progress') {
      return hasDelay && Number.isFinite(error.retry_after_seconds)
        && error.retry_after_seconds > 0 && error.retry_after_seconds <= 86400;
    }
    return !hasDelay;
  }

  function applyServerResults(job, results, now) {
    const expected = job.active_client_item_ids;
    if (!Array.isArray(results) || results.length !== expected.length
      || !results.every(validResult)) {
      throw codedError('invalid_server_response');
    }
    const resultIds = results.map((result) => result.client_item_id);
    const resultSet = new Set(resultIds);
    if (resultSet.size !== resultIds.length || resultSet.size !== expected.length
      || expected.some((clientItemId) => !resultSet.has(clientItemId))) {
      throw codedError('invalid_server_response');
    }

    const timestamp = transitionTimestamp(job, now);
    const byId = new Map(results.map((result) => [result.client_item_id, result]));
    const updated = clone(job);
    let retryExhausted = false;
    updated.items.forEach((item) => {
      const result = byId.get(item.client_item_id);
      if (!result) return;
      item.status = result.status;
      const resultError = result.error || null;
      const resultRetryable = resultError ? resultError.retryable : false;
      const exhausted = resultRetryable && item.attempt_count >= FINAL_ATTEMPT;
      item.retryable = result.status === 'created' || result.status === 'replayed'
        ? false : (resultRetryable && !exhausted);
      const retryAfterSeconds = resultError && Number.isFinite(resultError.retry_after_seconds)
        ? resultError.retry_after_seconds : retryDelaySeconds(item.attempt_count);
      if (exhausted) {
        retryExhausted = true;
        item.retry_after_at = null;
      } else {
        item.retry_after_at = resultRetryable
          ? timestamp + (retryAfterSeconds * 1000) : null;
      }
      item.error = resultError ? { code: resultError.code } : null;
      item.pin_id = result.status === 'created' || result.status === 'replayed'
        ? result.pin_id : null;
    });
    updated.active_client_item_ids = [];
    updated.revision = nextRevision(job);
    updated.updated_at = timestamp;
    if (retryExhausted) {
      updated.job_state = 'paused';
      updated.paused_reason = 'retry_exhausted';
    } else if (updated.items.every(isTerminal)) {
      updated.job_state = 'completed';
      updated.completed_at = timestamp;
    }
    return updated;
  }

  function buildBatchRequest(job) {
    if (!Array.isArray(job.active_client_item_ids)
      || job.active_client_item_ids.length === 0
      || job.active_client_item_ids.length > MAX_CHUNK_SIZE) {
      throw codedError('invalid_job_transition');
    }
    const active = new Set(job.active_client_item_ids);
    const items = job.items
      .filter((item) => active.has(item.client_item_id))
      .map((item) => ({ client_item_id: item.client_item_id, url: item.url }));
    if (items.length !== active.size) throw codedError('invalid_job_transition');
    return {
      batch_id: job.batch_id,
      board_ids: [...job.metadata.board_ids],
      tags: [...job.metadata.tags],
      private: job.metadata.private,
      referer: job.metadata.referer,
      description: job.metadata.description,
      items,
    };
  }

  function validateBatchEnvelope(envelope, job) {
    if (!hasExactKeys(envelope, ['batch_id', 'results', 'summary'])
      || envelope.batch_id !== job.batch_id || !Array.isArray(envelope.results)
      || !hasExactKeys(envelope.summary, ['conflict', 'created', 'failed', 'replayed'])
      || !Object.values(envelope.summary).every((count) => (
        Number.isInteger(count) && count >= 0
      ))) {
      throw codedError('invalid_server_response');
    }
    applyServerResults(job, envelope.results, () => job.updated_at);
    const actualSummary = {
      created: 0,
      replayed: 0,
      failed: 0,
      conflict: 0,
    };
    envelope.results.forEach((result) => { actualSummary[result.status] += 1; });
    if (Object.keys(actualSummary).some((status) => (
      actualSummary[status] !== envelope.summary[status]
    ))) throw codedError('invalid_server_response');
    return clone(envelope.results);
  }

  function recoverInterruptedChunk(job, now) {
    if (job.active_client_item_ids.length === 0) return clone(job);
    const timestamp = transitionTimestamp(job, now);
    const active = new Set(job.active_client_item_ids);
    const updated = clone(job);
    let retryExhausted = false;
    updated.items.forEach((item) => {
      if (active.has(item.client_item_id)) {
        item.status = 'unknown';
        const exhausted = item.attempt_count >= FINAL_ATTEMPT;
        retryExhausted = retryExhausted || exhausted;
        item.retryable = !exhausted;
        item.retry_after_at = exhausted ? null : timestamp;
        item.error = { code: 'worker_interrupted' };
        item.pin_id = null;
      }
    });
    updated.active_client_item_ids = [];
    updated.job_state = retryExhausted ? 'paused' : 'running';
    updated.paused_reason = retryExhausted ? 'retry_exhausted' : null;
    updated.revision = nextRevision(job);
    updated.updated_at = timestamp;
    return updated;
  }

  function markActiveUnknown(job, code, now, options = {}) {
    if (job.active_client_item_ids.length === 0) return clone(job);
    const timestamp = transitionTimestamp(job, now);
    const active = new Set(job.active_client_item_ids);
    const updated = clone(job);
    const retryable = workerItemRetryability(code);
    if (retryable === null || retryable !== Boolean(options.retry)) {
      throw codedError('invalid_job_transition');
    }
    let retryExhausted = false;
    updated.items.forEach((item) => {
      if (!active.has(item.client_item_id)) return;
      const exhausted = retryable && item.attempt_count >= FINAL_ATTEMPT;
      retryExhausted = retryExhausted || exhausted;
      item.status = 'unknown';
      item.retryable = retryable && !exhausted;
      item.retry_after_at = retryable && !exhausted
        ? timestamp + (retryDelaySeconds(item.attempt_count) * 1000) : null;
      item.error = { code };
      item.pin_id = null;
    });
    updated.active_client_item_ids = [];
    updated.job_state = retryExhausted || options.pauseReason ? 'paused' : 'running';
    updated.paused_reason = retryExhausted
      ? 'retry_exhausted' : (options.pauseReason || null);
    updated.revision = nextRevision(job);
    updated.updated_at = timestamp;
    return updated;
  }

  function pauseJob(job, reason, now) {
    const updated = clone(job);
    updated.job_state = 'paused';
    updated.paused_reason = reason;
    updated.revision = nextRevision(job);
    updated.updated_at = transitionTimestamp(job, now);
    return updated;
  }

  function retryJobItems(job, now) {
    const updated = clone(job);
    let changed = false;
    updated.items.forEach((item) => {
      if (item.status === 'pending') {
        changed = true;
        return;
      }
      const retryableStatus = item.status === 'unknown'
        || (item.status === 'failed' && item.retryable)
        || (item.status === 'conflict' && item.retryable)
        || isExhaustedRetryItem(item, job);
      if (!retryableStatus) return;
      item.status = 'pending';
      item.retryable = true;
      item.retry_after_at = null;
      item.attempt_count = 0;
      item.error = null;
      changed = true;
    });
    if (!changed) throw codedError('job_not_retryable');
    updated.active_client_item_ids = [];
    updated.job_state = 'running';
    updated.paused_reason = null;
    updated.revision = nextRevision(job);
    updated.updated_at = transitionTimestamp(job, now);
    return updated;
  }

  function tombstoneJob(job, now) {
    const updated = clone(job);
    if (updated.job_state !== 'completed') {
      const active = new Set(updated.active_client_item_ids);
      updated.items.forEach((item) => {
        if (!active.has(item.client_item_id)) return;
        item.status = 'pending';
        item.retryable = true;
        item.retry_after_at = null;
        item.attempt_count = 0;
        item.error = null;
        item.pin_id = null;
      });
      updated.job_state = 'paused';
      updated.paused_reason = 'discard_requested';
    }
    updated.discard_requested = true;
    updated.active_client_item_ids = [];
    updated.revision = nextRevision(job);
    updated.updated_at = transitionTimestamp(job, now);
    return updated;
  }

  function markCleanupJob(job, now) {
    const updated = clone(job);
    updated.cleanup_requested = true;
    updated.revision = nextRevision(job);
    updated.updated_at = transitionTimestamp(job, now);
    return updated;
  }

  function nextRetryAt(job) {
    const retryTimes = job.items
      .filter((item) => !isTerminal(item) && item.retryable && Number.isFinite(item.retry_after_at))
      .map((item) => item.retry_after_at);
    return retryTimes.length === 0 ? null : Math.min(...retryTimes);
  }

  function jobStorageKey(batchId) {
    if (!isSafeId(batchId)) {
      throw codedError('invalid_batch_id');
    }
    return `pinry.job.${batchId}`;
  }

  function validSnapshotError(status, error, retryable) {
    if (!hasExactKeys(error, ['code']) || typeof error.code !== 'string') return false;
    if (status === 'unknown') {
      const expectedRetryable = workerItemRetryability(error.code);
      return expectedRetryable !== null
        && (retryable === expectedRetryable || expectedRetryable === true);
    }
    if (!Object.hasOwn(SAFE_SERVER_RETRYABILITY, error.code)) return false;
    const expectedStatus = error.code === 'in_progress'
      || error.code === 'idempotency_mismatch' || error.code === 'lease_lost'
      ? 'conflict' : 'failed';
    const fixedRetryable = SAFE_SERVER_RETRYABILITY[error.code];
    return status === expectedStatus
      && (fixedRetryable === null || retryable === fixedRetryable || fixedRetryable === true);
  }

  function validSnapshotItem(item) {
    if (!hasExactKeys(item, [
      'attempt_count', 'client_item_id', 'error', 'pin_id', 'retry_after_at',
      'retryable', 'status', 'url',
    ]) || !isSafeId(item.client_item_id) || !ITEM_STATUSES.has(item.status)
      || typeof item.retryable !== 'boolean'
      || !Number.isInteger(item.attempt_count) || item.attempt_count < 0
      || item.attempt_count > FINAL_ATTEMPT
      || (item.retry_after_at !== null && !isFiniteTime(item.retry_after_at))) {
      return false;
    }
    try {
      validateUrl(item.url);
    } catch (_error) {
      return false;
    }
    if (item.status === 'pending') {
      return item.retryable && item.retry_after_at === null
        && item.error === null && item.pin_id === null;
    }
    if (item.status === 'created' || item.status === 'replayed') {
      return item.retryable === false && item.retry_after_at === null && item.error === null
        && Number.isInteger(item.pin_id) && item.pin_id > 0 && item.attempt_count >= 1;
    }
    if (item.attempt_count < 1 || item.pin_id !== null
      || !validSnapshotError(item.status, item.error, item.retryable)) {
      return false;
    }
    if (item.retryable) {
      return item.attempt_count <= MAX_AUTO_ATTEMPTS
        && isFiniteTime(item.retry_after_at);
    }
    return item.retry_after_at === null;
  }

  function validPausedReason(reason) {
    return PAUSED_REASONS.has(reason)
      || (typeof reason === 'string' && /^http_4[0-9]{2}$/.test(reason)
        && reason !== 'http_429');
  }

  function isJobSnapshot(value) {
    const requiredKeys = [
      'active_client_item_ids', 'batch_id', 'completed_at', 'created_at', 'items',
      'job_state', 'metadata', 'paused_reason', 'revision', 'schema_version',
      'server_configuration_id', 'server_origin', 'server_username', 'source_tab_id',
      'updated_at',
    ];
    if (!isPlainObject(value) || value.schema_version !== 1
      || !Object.keys(value).every((key) => requiredKeys.includes(key)
        || key === 'discard_requested' || key === 'cleanup_requested')
      || !requiredKeys.every((key) => Object.hasOwn(value, key))
      || !isSafeId(value.batch_id) || !isSafeId(value.server_configuration_id)
      || typeof value.server_username !== 'string' || value.server_username === ''
      || byteLength(value.server_username) > MAX_TAG_BYTES
      || !Number.isInteger(value.source_tab_id) || value.source_tab_id < 0
      || !JOB_STATES.has(value.job_state) || !Number.isSafeInteger(value.revision)
      || value.revision < 1 || value.revision > MAX_PERSISTED_REVISION
      || !isFiniteTime(value.created_at)
      || !isFiniteTime(value.updated_at) || value.updated_at < value.created_at
      || !Array.isArray(value.items) || value.items.length < 1
      || value.items.length > MAX_CANDIDATES
      || !Array.isArray(value.active_client_item_ids)
      || value.active_client_item_ids.length > MAX_CHUNK_SIZE) return false;
    try {
      validateServerOrigin(value.server_origin);
      validateMetadata(value.metadata);
    } catch (_error) {
      return false;
    }
    if (!hasExactKeys(value.metadata, [
      'board_ids', 'description', 'private', 'referer', 'tags',
    ]) || !value.items.every(validSnapshotItem)) return false;
    const itemIds = value.items.map((item) => item.client_item_id);
    const idSet = new Set(itemIds);
    const activeSet = new Set(value.active_client_item_ids);
    if (idSet.size !== itemIds.length || activeSet.size !== value.active_client_item_ids.length
      || value.active_client_item_ids.some((id) => !idSet.has(id))) return false;
    const activeItems = value.items.filter((item) => activeSet.has(item.client_item_id));
    const exhaustedItems = value.items.filter((item) => isExhaustedRetryItem(item, value));
    if (value.items.some((item) => requiresRetryability(item)
      && item.retryable === false && !exhaustedItems.includes(item))) return false;
    const attemptedPendingIds = value.items
      .filter((item) => item.status === 'pending' && item.attempt_count >= 1)
      .map((item) => item.client_item_id);
    if (activeItems.some((item) => item.status !== 'pending' || item.attempt_count < 1)
      || attemptedPendingIds.length !== activeSet.size
      || attemptedPendingIds.some((id) => !activeSet.has(id))) return false;
    const hasNonterminal = value.items.some((item) => !isTerminal(item))
      || exhaustedItems.length > 0;
    if (value.active_client_item_ids.length > 0 && value.job_state !== 'running') return false;
    if (value.job_state === 'running') {
      if (value.paused_reason !== null || value.completed_at !== null || !hasNonterminal) return false;
    }
    if (value.job_state === 'paused') {
      if (value.active_client_item_ids.length > 0 || value.completed_at !== null
        || !validPausedReason(value.paused_reason) || !hasNonterminal) return false;
      if (value.paused_reason === 'retry_exhausted' && exhaustedItems.length === 0) return false;
    }
    if (value.job_state === 'completed') {
      if (value.active_client_item_ids.length > 0 || value.paused_reason !== null
        || !isFiniteTime(value.completed_at) || value.completed_at < value.created_at
        || value.completed_at > value.updated_at || !value.items.every(isTerminal)) return false;
    }
    const hasDiscardMarker = Object.hasOwn(value, 'discard_requested');
    if (value.paused_reason === 'discard_requested' && !hasDiscardMarker) return false;
    if (hasDiscardMarker
      && (value.discard_requested !== true
        || (value.job_state === 'completed'
          ? value.paused_reason !== null
          : value.paused_reason !== 'discard_requested'))) return false;
    if (Object.hasOwn(value, 'cleanup_requested')
      && (value.cleanup_requested !== true || value.job_state !== 'completed')) return false;
    return byteLength(JSON.stringify(value)) <= MAX_JOB_BYTES;
  }

  function workerItemRetryability(code) {
    if (Object.hasOwn(WORKER_ITEM_RETRYABILITY, code)) {
      return WORKER_ITEM_RETRYABILITY[code];
    }
    if (typeof code === 'string' && /^http_4[0-9]{2}$/.test(code) && code !== 'http_429') {
      return false;
    }
    return null;
  }

  function requiresRetryability(item) {
    if (!item.error || typeof item.error.code !== 'string') return false;
    if (item.status === 'unknown') return workerItemRetryability(item.error.code) === true;
    return (item.status === 'failed' || item.status === 'conflict')
      && SAFE_SERVER_RETRYABILITY[item.error.code] === true;
  }

  function isExhaustedRetryItem(item, job) {
    if (!job || job.job_state !== 'paused' || job.paused_reason !== 'retry_exhausted'
      || item.attempt_count !== FINAL_ATTEMPT || item.retryable !== false
      || item.retry_after_at !== null || !item.error) return false;
    if (requiresRetryability(item)) return true;
    return (item.status === 'failed' || item.status === 'conflict')
      && SAFE_SERVER_RETRYABILITY[item.error.code] === null;
  }

  function retryDelaySeconds(attemptCount) {
    const index = Math.max(0, Math.min(RETRY_DELAYS.length - 1, attemptCount - 1));
    return RETRY_DELAYS[index];
  }

  function withJobLock(batchId, callback) {
    const previous = locks.get(batchId) || Promise.resolve();
    const running = previous.then(callback, callback);
    const settled = running.then(() => undefined, () => undefined);
    locks.set(batchId, settled);
    settled.then(() => {
      if (locks.get(batchId) === settled) locks.delete(batchId);
    });
    return running;
  }

  return {
    MAX_CANDIDATES,
    MAX_CHUNK_SIZE,
    activateChunk,
    applyServerResults,
    buildBatchRequest,
    codedError,
    createJob,
    isJobSnapshot,
    jobStorageKey,
    markCleanupJob,
    markActiveUnknown,
    nextChunk,
    nextRetryAt,
    pauseJob,
    recoverInterruptedChunk,
    retryDelaySeconds,
    retryJobItems,
    tombstoneJob,
    validateBatchEnvelope,
    withJobLock,
  };
}));
