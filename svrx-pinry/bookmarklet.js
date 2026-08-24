(function exposeBookmarklet(root, factory) {
  const api = factory();
  root.PinryBookmarklet = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(globalThis, function buildBookmarkletApi() {
  'use strict';

  const OVERLAY_ID = 'pinry-images';

  function createButton(documentObject, text, className) {
    const button = documentObject.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.className = className;
    return button;
  }

  function appendVisibleLabel(documentObject, parent, text, control) {
    const label = documentObject.createElement('label');
    label.textContent = text;
    label.setAttribute('for', control.id);
    parent.appendChild(label);
    parent.appendChild(control);
    return label;
  }

  function appendField(documentObject, parent, text, control, className = '') {
    const field = documentObject.createElement('div');
    field.className = `pinry-field${className ? ` ${className}` : ''}`;
    appendVisibleLabel(documentObject, field, text, control);
    parent.appendChild(field);
    return field;
  }

  function appendCheckboxField(documentObject, parent, text, control, className = '') {
    const field = documentObject.createElement('div');
    field.className = `pinry-checkbox-field${className ? ` ${className}` : ''}`;
    field.appendChild(control);
    const label = documentObject.createElement('label');
    label.textContent = text;
    label.setAttribute('for', control.id);
    field.appendChild(label);
    parent.appendChild(field);
    return field;
  }

  function composedTarget(event) {
    if (event && typeof event.composedPath === 'function') {
      const path = event.composedPath();
      if (Array.isArray(path) && path.length > 0) return path[0];
    }
    return event ? event.target : null;
  }

  function isRetryNeeded(item) {
    return item.status === 'unknown'
      || ((item.status === 'failed' || item.status === 'conflict')
        && item.retryable === true);
  }

  function summarizeJobForUser(job) {
    const summary = {
      success: 0,
      pending: 0,
      retryNeeded: 0,
      failed: 0,
      final: job.job_state === 'completed',
    };
    for (const item of job.items) {
      if (item.status === 'created' || item.status === 'replayed') summary.success += 1;
      else if (item.status === 'pending') summary.pending += 1;
      else if (isRetryNeeded(item)) summary.retryNeeded += 1;
      else summary.failed += 1;
    }
    return summary;
  }

  const ITEM_STATUS_LABELS = Object.freeze({
    pending: '처리 대기',
    created: '생성 완료',
    replayed: '생성 완료',
    failed: '생성 실패',
    conflict: '처리 충돌',
    unknown: '상태 확인 필요',
  });

  const USER_MESSAGE_BY_CODE = Object.freeze({
    creating: 'Pin을 만드는 중입니다.',
    discarded: '작업을 버렸습니다.',
    network_error: '서버에 연결하지 못했습니다.',
    temporary_server_error: '서버에 일시적인 문제가 발생했습니다.',
    invalid_server_response: '서버 응답을 확인하지 못했습니다.',
    invalid_sender: '요청을 보낸 페이지를 확인하지 못했습니다.',
    invalid_server_configuration: 'Pinry 서버 설정을 확인해 주세요.',
    server_configuration_changed: 'Pinry 서버 설정이 변경되었습니다.',
    server_not_configured: 'Pinry 서버를 먼저 설정해 주세요.',
    host_permission_required: '서버 주소에 대한 브라우저 권한이 필요합니다.',
    bootstrap_unavailable: '서버 설정을 불러오지 못했습니다.',
    job_status_unavailable: '작업 상태를 확인하지 못했습니다.',
    job_create_failed: 'Pin 생성 작업을 시작하지 못했습니다.',
    job_retry_failed: '작업을 다시 시도하지 못했습니다.',
    job_discard_failed: '작업을 버리지 못했습니다.',
    job_already_exists: '진행 중인 Pin 생성 작업이 있습니다.',
    job_discarded: '이미 버려진 작업입니다.',
    job_not_found: '진행 중인 작업을 찾지 못했습니다.',
    job_not_retryable: '이 작업은 다시 시도할 수 없습니다.',
    job_id_unavailable: '작업 번호를 만들지 못했습니다.',
    job_too_large: '한 번에 처리할 수 있는 Pin 개수를 넘었습니다.',
    job_scan_limit_exceeded: '작업 목록을 확인하는 범위를 넘었습니다.',
    invalid_batch_id: '작업 정보가 올바르지 않습니다.',
    stale_job_revision: '작업 상태가 이미 변경되었습니다.',
    invalid_board_request: '새 보드 이름을 입력해 주세요.',
    board_create_failed: '보드를 만들지 못했습니다.',
    no_candidates: '선택한 이미지가 없습니다.',
    too_many_candidates: '선택한 이미지가 너무 많습니다.',
    candidate_collection_failed: '이미지 후보를 모으지 못했습니다.',
    candidate_payload_too_large: '선택한 이미지 정보가 너무 큽니다.',
    invalid_candidate_url: '사용할 수 없는 이미지 주소입니다.',
    invalid_job_metadata: 'Pin 설정 정보가 올바르지 않습니다.',
    pending_storage_failed: '대기 작업을 저장하지 못했습니다.',
    storage_write_failed: '확장 프로그램 저장소에 기록하지 못했습니다.',
    webextension_api_error: '브라우저 확장 기능을 사용하지 못했습니다.',
    alarm_api_unavailable: '자동 작업 기능을 사용하지 못했습니다.',
    alarm_schedule_failed: '자동 작업을 예약하지 못했습니다.',
    worker_interrupted: '작업이 중단되었습니다.',
    overlay_connection_lost: '확장 프로그램과의 연결이 끊어졌습니다.',
    overlay_initialization_failed: 'Pin 생성 화면을 열지 못했습니다.',
    overlay_integrity_failed: 'Pin 생성 화면을 안전하게 열지 못했습니다.',
    overlay_protocol_error: '확장 프로그램 통신에 문제가 발생했습니다.',
    overlay_session_expired: 'Pin 생성 화면의 연결 시간이 만료되었습니다.',
    overlay_session_limit: '동시에 열 수 있는 Pin 생성 화면 수를 넘었습니다.',
    overlay_session_replaced: '다른 Pin 생성 화면이 열렸습니다.',
    open_options_failed: '확장 프로그램 설정을 열지 못했습니다.',
    invalid_image_content: '올바른 이미지 파일이 아닙니다.',
    unsupported_image_format: '지원하지 않는 이미지 형식입니다.',
    unsupported_http_stack: '이미지 서버와 통신할 수 없는 환경입니다.',
    invalid_url_policy: '보안 정책상 사용할 수 없는 이미지 주소입니다.',
    blocked_address: '보안상 접근할 수 없는 이미지 주소입니다.',
    dns_rebinding_detected: '이미지 주소의 네트워크 정보가 안전하지 않습니다.',
    too_many_redirects: '이미지 주소가 너무 많이 이동되었습니다.',
    unsupported_content_encoding: '지원하지 않는 방식으로 압축된 이미지 응답입니다.',
    image_too_large: '이미지 파일이 너무 큽니다.',
    image_too_many_pixels: '이미지 해상도가 너무 큽니다.',
    image_download_failed: '이미지를 다운로드하지 못했습니다.',
    image_fetch_timeout: '이미지 다운로드 시간을 넘었습니다.',
    image_processing_timeout: '이미지 처리 시간을 넘었습니다.',
    image_processing_failed: '이미지를 처리하지 못했습니다.',
    media_configuration_error: '이미지 저장소 설정을 확인해 주세요.',
    media_path_conflict: '이미지 저장 경로가 충돌했습니다.',
    media_publish_changed: '이미지 저장 상태가 변경되었습니다.',
    media_storage_failed: '이미지를 저장하지 못했습니다.',
    media_storage_unsupported: '지원하지 않는 이미지 저장소입니다.',
    lease_lost: '다른 작업과 처리 순서가 충돌했습니다.',
    board_access_changed: '보드 접근 권한이 변경되었습니다.',
    database_busy: '서버가 다른 작업을 처리 중입니다.',
    pin_permanently_deleted: '해당 Pin은 이미 삭제되었습니다.',
    idempotency_mismatch: '기존 작업 정보와 요청 내용이 다릅니다.',
    batch_deadline_exceeded: '작업 처리 시간을 넘었습니다.',
    in_progress: '이미 처리 중인 작업입니다.',
    unexpected_error: '예상하지 못한 문제가 발생했습니다.',
    internal_error: '서버 내부 문제가 발생했습니다.',
  });

  function userMessageForCode(code) {
    if (typeof code === 'string' && /^http_4[0-9]{2}$/.test(code)) {
      return '이미지 서버에서 파일을 가져오지 못했습니다.';
    }
    return Object.hasOwn(USER_MESSAGE_BY_CODE, code)
      ? USER_MESSAGE_BY_CODE[code] : '요청을 처리하지 못했습니다.';
  }

  function openCreatedPins(scope, bootstrap) {
    if (!scope || typeof scope.open !== 'function' || !bootstrap
      || typeof bootstrap.origin !== 'string'
      || typeof bootstrap.username !== 'string' || bootstrap.username === '') return;
    let origin;
    let target;
    try {
      origin = new URL(bootstrap.origin);
      target = new URL(
        `/pins/users/${encodeURIComponent(bootstrap.username)}`,
        bootstrap.origin,
      );
    } catch (_error) {
      return;
    }
    if ((origin.protocol !== 'https:' && origin.protocol !== 'http:')
      || origin.origin !== bootstrap.origin || origin.pathname !== '/'
      || origin.search || origin.hash || target.origin !== bootstrap.origin
      || target.search || target.hash) return;
    scope.open(target.href, '_blank', 'noopener');
  }

  function openOverlay(scope, options) {
    const documentObject = options && options.document;
    const mountRoot = options && options.mountRoot;
    const requestTransport = options && options.requestTransport;
    const selectionApi = options && options.selectionApi;
    if (!documentObject || !mountRoot || typeof mountRoot.appendChild !== 'function'
      || !requestTransport || typeof requestTransport.request !== 'function'
      || typeof requestTransport.subscribe !== 'function'
      || !selectionApi || typeof selectionApi.SelectionModel !== 'function'
      || !options.candidatePromise || typeof options.candidatePromise.then !== 'function'
      || !options.pageDefaults || typeof options.onClose !== 'function') {
      throw new Error('renderer_configuration_invalid');
    }
    const pageDefaults = Object.freeze({
      description: options.pageDefaults.description,
      referer: options.pageDefaults.referer,
    });
    let disposed = false;
    let closeNotified = false;
    const style = documentObject.createElement('style');
    style.textContent = `
      html, body {
        margin: 0;
        min-height: 100%;
        color: #f4f7f8;
        color-scheme: dark;
        direction: ltr;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 16px;
        line-height: 1.5;
      }
      #pinry-images,
      #pinry-images * { box-sizing: border-box; }
      #pinry-images {
        --svrx-bg: #090d10;
        --svrx-toolbar: #10151a;
        --svrx-workspace: #11161b;
        --svrx-surface: #171d22;
        --svrx-surface-raised: #1d252b;
        --svrx-border: #354047;
        --svrx-text: #f4f7f8;
        --svrx-muted: #9da8ae;
        --svrx-accent: #278e86;
        --svrx-accent-hover: #32a69c;
        --svrx-focus: #63d6cc;
        --svrx-success: #55c59f;
        --svrx-warning: #e0a449;
        --svrx-danger: #ef6b73;
        position: fixed;
        z-index: 2147483647;
        inset: 0;
        overflow-y: auto;
        margin: 0;
        padding: 96px 24px 32px;
        background: var(--svrx-bg);
        color: var(--svrx-text);
        font-family: inherit;
        font-size: 16px;
        line-height: 1.5;
        text-align: left;
      }
      #pinry-images .pinry-title {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
      }
      #pinry-images .pinry-toolbar {
        position: fixed;
        z-index: 2147483647;
        top: 0;
        left: 0;
        right: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        min-height: 76px;
        padding: 16px;
        background: var(--svrx-toolbar);
        border-bottom: 1px solid var(--svrx-border);
      }
      #pinry-images button,
      #pinry-images input,
      #pinry-images select,
      #pinry-images textarea {
        color: var(--svrx-text);
        font: inherit;
      }
      #pinry-images button {
        min-height: 44px;
        padding: 8px 16px;
        border: 1px solid var(--svrx-border);
        border-radius: 8px;
        background: var(--svrx-surface-raised);
        cursor: pointer;
      }
      #pinry-images button:hover:not(:disabled) {
        border-color: var(--svrx-muted);
        background: var(--svrx-workspace);
      }
      #pinry-images button:focus-visible,
      #pinry-images input:focus-visible,
      #pinry-images select:focus-visible,
      #pinry-images textarea:focus-visible,
      #pinry-images .pinry-candidate:focus-visible {
        outline: 3px solid var(--svrx-focus);
        outline-offset: 2px;
      }
      #pinry-images button:disabled { cursor: default; opacity: 0.5; }
      #pinry-images .pinry-toolbar-left,
      #pinry-images .pinry-toolbar-right {
        display: flex;
        align-items: center;
        flex-wrap: nowrap;
        gap: 8px;
        min-width: 0;
      }
      #pinry-images .pinry-toolbar-left { justify-self: start; }
      #pinry-images .pinry-toolbar-right { justify-self: end; justify-content: flex-end; }
      #pinry-images .pinry-toolbar-brand {
        display: flex;
        align-items: center;
        justify-self: center;
        gap: 8px;
        white-space: nowrap;
        font-size: 18px;
        font-weight: 700;
      }
      #pinry-images .pinry-toolbar-brand-icon { width: 24px; height: 24px; }
      #pinry-images .pinry-toolbar-brand-copy { display: grid; }
      #pinry-images .pinry-toolbar-brand-note {
        color: var(--svrx-muted);
        font-size: 12px;
        font-weight: 400;
      }
      #pinry-images .pinry-toolbar button { white-space: nowrap; }
      #pinry-images .pinry-workspace {
        display: grid;
        width: 100%;
        max-width: 1560px;
        margin: 0 auto;
        grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
        align-items: start;
        gap: 16px;
      }
      #pinry-images .pinry-metadata-panel {
        min-width: 0;
        overflow: hidden;
        border: 1px solid var(--svrx-border);
        border-radius: 14px;
        background: var(--svrx-surface);
      }
      #pinry-images .pinry-settings-card {
        position: sticky;
        top: 0;
        max-height: calc(100vh - 124px);
        overflow-y: auto;
      }
      #pinry-images .pinry-metadata-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 16px 24px;
        border-bottom: 1px solid var(--svrx-border);
        background: var(--svrx-workspace);
      }
      #pinry-images .pinry-metadata-heading { display: grid; }
      #pinry-images .pinry-metadata-title,
      #pinry-images .pinry-candidate-title {
        margin: 0;
        font-size: 22px;
        font-weight: 700;
        line-height: 1.25;
      }
      #pinry-images .pinry-settings-subtitle {
        color: var(--svrx-muted);
        font-size: 13px;
      }
      #pinry-images .pinry-transport-status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
      }
      #pinry-images .pinry-transport-status::before {
        content: '';
        flex: 0 0 auto;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: currentColor;
      }
      #pinry-images .pinry-transport-status[data-state="connected"] {
        color: var(--svrx-success);
      }
      #pinry-images .pinry-transport-status[data-state="reconnecting"] {
        color: var(--svrx-warning);
      }
      #pinry-images .pinry-transport-status[data-state="terminal"] {
        color: var(--svrx-danger);
      }
      #pinry-images .pinry-metadata-body { padding: 24px; }
      #pinry-images .pinry-settings-flow {
        display: grid;
        gap: 8px;
      }
      #pinry-images .pinry-settings-section { min-width: 0; }
      #pinry-images .pinry-section-title {
        margin: 0 0 16px;
        font-size: 16px;
        font-weight: 700;
        line-height: 1.4;
      }
      #pinry-images .pinry-field {
        display: grid;
        gap: 8px;
        margin: 0;
      }
      #pinry-images .pinry-field > label { font-weight: 600; }
      #pinry-images .pinry-metadata-panel input:not([type="checkbox"]),
      #pinry-images .pinry-metadata-panel select,
      #pinry-images .pinry-metadata-panel textarea {
        width: 100%;
        min-height: 44px;
        padding: 8px 16px;
        border: 1px solid var(--svrx-border);
        border-radius: 8px;
        background: var(--svrx-toolbar);
      }
      #pinry-images .pinry-metadata-panel textarea { min-height: 88px; resize: vertical; }
      #pinry-images .pinry-checkbox-field {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 44px;
        margin: 0;
      }
      #pinry-images .pinry-checkbox-field input[type="checkbox"] {
        flex: 0 0 auto;
        width: 20px;
        height: 20px;
        margin: 0;
        accent-color: var(--svrx-accent);
      }
      #pinry-images .pinry-checkbox-field label { cursor: pointer; }
      #pinry-images .pinry-new-board-details {
        margin-top: 8px;
        padding: 16px;
        border: 1px solid var(--svrx-border);
        border-radius: 14px;
        background: var(--svrx-surface-raised);
      }
      #pinry-images .pinry-new-board-details > summary,
      #pinry-images .pinry-details > summary {
        min-height: 44px;
        cursor: pointer;
        font-weight: 600;
        line-height: 44px;
      }
      #pinry-images .pinry-new-board-details .pinry-field,
      #pinry-images .pinry-new-board-details .pinry-checkbox-field { margin-top: 8px; }
      #pinry-images .pinry-create-board { margin-top: 8px; }
      #pinry-images .pinry-tag-suggestions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      #pinry-images .pinry-tag-suggestions button {
        min-height: 44px;
        padding: 8px 16px;
        border-radius: 16px;
      }
      #pinry-images .pinry-details {
        border-top: 1px solid var(--svrx-border);
      }
      #pinry-images .pinry-details .pinry-field { margin-top: 8px; }
      #pinry-images .pinry-job-status { margin-top: 16px; }
      #pinry-images .pinry-job-status:empty,
      #pinry-images .pinry-job-items:empty { display: none; }
      #pinry-images .pinry-job-items { margin-top: 8px; }
      #pinry-images .pinry-job-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
      }
      #pinry-images .pinry-metadata-footer {
        display: flex;
        justify-content: flex-start;
        gap: 8px;
        padding: 16px 24px;
        border-top: 1px solid var(--svrx-border);
        background: var(--svrx-workspace);
      }
      #pinry-images .pinry-metadata-footer .pinry-submit { flex: 1 1 auto; }
      #pinry-images .pinry-submit {
        border-color: var(--svrx-accent);
        background: var(--svrx-accent);
        color: var(--svrx-bg);
        font-weight: 700;
      }
      #pinry-images .pinry-submit:hover:not(:disabled) {
        border-color: var(--svrx-accent-hover);
        background: var(--svrx-accent-hover);
      }
      #pinry-images .pinry-candidate-canvas {
        min-width: 0;
        padding: 16px;
        border: 1px solid var(--svrx-border);
        border-radius: 14px;
        background: var(--svrx-workspace);
      }
      #pinry-images .pinry-candidate-header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 16px;
      }
      #pinry-images .pinry-candidate-summary { color: var(--svrx-muted); }
      #pinry-images .pinry-candidate-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 8px;
      }
      #pinry-images .pinry-candidate {
        position: relative;
        min-width: 0;
        overflow: hidden;
        padding: 0;
        border: 2px solid var(--svrx-border);
        border-radius: 14px;
        background: var(--svrx-surface);
        cursor: pointer;
      }
      #pinry-images .pinry-candidate[aria-selected="true"] {
        border-color: var(--svrx-accent-hover);
        background: var(--svrx-surface-raised);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
      }
      #pinry-images .pinry-candidate-image,
      #pinry-images .pinry-preview-placeholder {
        display: block;
        width: 100%;
        height: 164px;
        object-fit: cover;
      }
      #pinry-images .pinry-preview-placeholder {
        display: grid;
        place-items: center;
        padding: 16px;
        color: var(--svrx-muted);
        background: var(--svrx-toolbar);
        text-align: center;
      }
      #pinry-images .pinry-candidate-checkbox {
        position: absolute;
        z-index: 1;
        top: 8px;
        right: 8px;
        display: inline-grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border: 2px solid var(--svrx-text);
        border-radius: 14px;
        background: var(--svrx-toolbar);
      }
      #pinry-images .pinry-candidate[aria-selected="true"] .pinry-candidate-checkbox {
        border-color: var(--svrx-focus);
        background: var(--svrx-accent-hover);
      }
      #pinry-images .pinry-candidate-number,
      #pinry-images .pinry-candidate-dimensions {
        display: inline-block;
        padding: 8px;
        color: var(--svrx-muted);
        font-size: 13px;
      }
      #pinry-images .pinry-candidate-number { font-weight: 700; }
      #pinry-images .pinry-candidate-dimensions { float: right; text-align: right; }
      #pinry-images .pinry-loading,
      #pinry-images .pinry-limit-message {
        margin: 16px 0;
        color: var(--svrx-muted);
        text-align: center;
      }
      @media (max-width: 1080px) {
        #pinry-images .pinry-workspace {
          grid-template-columns: 1fr;
        }
        #pinry-images .pinry-settings-card {
          position: static;
          max-height: none;
        }
      }
      @media (max-width: 820px) {
        #pinry-images .pinry-toolbar-brand-note { display: none; }
      }
      @media (min-width: 681px) and (max-width: 820px) {
        #pinry-images .pinry-toolbar {
          gap: 8px;
          padding: 8px 16px;
        }
        #pinry-images .pinry-toolbar-left,
        #pinry-images .pinry-toolbar-right { gap: 8px; }
        #pinry-images .pinry-toolbar-brand { gap: 8px; font-size: 13px; }
        #pinry-images .pinry-toolbar button {
          min-height: 44px;
          padding: 8px;
          font-size: 12px;
        }
        #pinry-images .pinry-selection-count { font-size: 12px; }
      }
      @media (max-width: 680px) {
        #pinry-images { padding: 136px 16px 24px; }
        #pinry-images .pinry-toolbar {
          grid-template-columns: 1fr auto;
          gap: 8px;
          padding: 8px 16px;
        }
        #pinry-images .pinry-toolbar-brand {
          grid-column: 1 / -1;
          grid-row: 1;
        }
        #pinry-images .pinry-toolbar-left { grid-column: 1; grid-row: 2; }
        #pinry-images .pinry-toolbar-right { grid-column: 2; grid-row: 2; }
        #pinry-images .pinry-toolbar-left,
        #pinry-images .pinry-toolbar-right { flex-wrap: nowrap; gap: 8px; }
        #pinry-images .pinry-selection-count { font-size: 12px; }
        #pinry-images .pinry-toolbar button {
          min-height: 44px;
          padding: 8px;
          font-size: 12px;
          white-space: nowrap;
        }
        #pinry-images .pinry-workspace { gap: 8px; }
        #pinry-images .pinry-metadata-header,
        #pinry-images .pinry-metadata-body,
        #pinry-images .pinry-metadata-footer,
        #pinry-images .pinry-candidate-canvas { padding-left: 16px; padding-right: 16px; }
        #pinry-images .pinry-candidate-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        #pinry-images .pinry-candidate-image,
        #pinry-images .pinry-preview-placeholder { height: 112px; }
        #pinry-images .pinry-candidate-header {
          align-items: start;
          flex-direction: column;
        }
        #pinry-images .pinry-metadata-footer .pinry-close { flex: 0 0 96px; }
        #pinry-images .pinry-metadata-footer .pinry-submit {
          flex: 1 1 auto;
          min-width: 0;
        }
      }
    `;
    mountRoot.appendChild(style);

    const overlay = documentObject.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'pinry-selection-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'pinry-overlay-title');
    const title = documentObject.createElement('h1');
    title.id = 'pinry-overlay-title';
    title.className = 'pinry-title';
    title.textContent = 'SVRx Pinry 이미지 선택';
    overlay.appendChild(title);

    const toolbar = documentObject.createElement('div');
    toolbar.id = 'pinry-bar';
    toolbar.className = 'pinry-toolbar';

    const toolbarLeft = documentObject.createElement('div');
    toolbarLeft.className = 'pinry-toolbar-left';
    const toolbarBrand = documentObject.createElement('div');
    toolbarBrand.className = 'pinry-toolbar-brand';
    const toolbarBrandIcon = documentObject.createElement('img');
    toolbarBrandIcon.className = 'pinry-toolbar-brand-icon';
    toolbarBrandIcon.src = options.brandIconUrl || 'brand-dark-ui-48.png';
    toolbarBrandIcon.setAttribute('alt', '');
    const toolbarBrandName = documentObject.createElement('span');
    toolbarBrandName.className = 'pinry-toolbar-brand-name';
    toolbarBrandName.textContent = 'SVRx Pinry';
    const toolbarBrandNote = documentObject.createElement('span');
    toolbarBrandNote.className = 'pinry-toolbar-brand-note';
    toolbarBrandNote.textContent = '바깥 영역을 클릭하면 닫힙니다';
    const toolbarBrandCopy = documentObject.createElement('span');
    toolbarBrandCopy.className = 'pinry-toolbar-brand-copy';
    toolbarBrandCopy.appendChild(toolbarBrandName);
    toolbarBrandCopy.appendChild(toolbarBrandNote);
    toolbarBrand.appendChild(toolbarBrandIcon);
    toolbarBrand.appendChild(toolbarBrandCopy);
    const toolbarRight = documentObject.createElement('div');
    toolbarRight.className = 'pinry-toolbar-right';

    const selectAll = createButton(
      documentObject,
      '전체 선택',
      'pinry-select-all',
    );
    const clearAll = createButton(
      documentObject,
      '전체 해제',
      'pinry-clear-all',
    );
    const selectionCount = documentObject.createElement('span');
    selectionCount.className = 'pinry-selection-count';
    selectionCount.textContent = '0개 선택';
    const toolbarSubmit = createButton(
      documentObject,
      '선택한 Pin 만들기',
      'pinry-toolbar-submit pinry-submit',
    );
    toolbarSubmit.setAttribute('aria-label', '선택한 Pin 만들기');
    toolbarSubmit.disabled = true;
    const toolbarCloseButton = createButton(
      documentObject,
      '닫기',
      'pinry-toolbar-close pinry-close',
    );
    const submit = createButton(
      documentObject,
      '선택한 Pin 만들기',
      'pinry-submit',
    );
    submit.disabled = true;
    const closeButton = createButton(
      documentObject,
      '닫기',
      'pinry-close',
    );
    toolbarLeft.appendChild(selectAll);
    toolbarLeft.appendChild(clearAll);
    toolbarRight.appendChild(selectionCount);
    toolbarRight.appendChild(toolbarCloseButton);
    toolbarRight.appendChild(toolbarSubmit);
    toolbar.appendChild(toolbarLeft);
    toolbar.appendChild(toolbarBrand);
    toolbar.appendChild(toolbarRight);
    overlay.appendChild(toolbar);

    const workspace = documentObject.createElement('div');
    workspace.className = 'pinry-workspace';
    overlay.appendChild(workspace);

    const metadataPanel = documentObject.createElement('div');
    metadataPanel.className = 'pinry-metadata-panel pinry-settings-card';
    const metadataHeader = documentObject.createElement('div');
    metadataHeader.className = 'pinry-metadata-header';
    const metadataHeading = documentObject.createElement('div');
    metadataHeading.className = 'pinry-metadata-heading';
    const metadataTitle = documentObject.createElement('h2');
    metadataTitle.className = 'pinry-metadata-title';
    metadataTitle.textContent = 'Pin 설정';
    const settingsSubtitle = documentObject.createElement('span');
    settingsSubtitle.className = 'pinry-settings-subtitle';
    settingsSubtitle.textContent = '선택한 이미지에 공통 적용';
    metadataHeading.appendChild(metadataTitle);
    metadataHeading.appendChild(settingsSubtitle);
    metadataHeader.appendChild(metadataHeading);
    metadataPanel.appendChild(metadataHeader);

    const metadataBody = documentObject.createElement('div');
    metadataBody.className = 'pinry-metadata-body';
    const settingsFlow = documentObject.createElement('div');
    settingsFlow.className = 'pinry-settings-flow';
    const boardSettings = documentObject.createElement('section');
    boardSettings.className = 'pinry-settings-section pinry-board-settings';
    const boardSettingsTitle = documentObject.createElement('h3');
    boardSettingsTitle.className = 'pinry-section-title';
    boardSettingsTitle.textContent = '보드 설정';
    boardSettings.appendChild(boardSettingsTitle);
    settingsFlow.appendChild(boardSettings);
    metadataBody.appendChild(settingsFlow);

    const boardSelect = documentObject.createElement('select');
    boardSelect.id = 'pinry-board-select';
    boardSelect.className = 'pinry-board-select';
    const noBoardOption = documentObject.createElement('option');
    noBoardOption.value = '';
    noBoardOption.textContent = '보드 지정 안 함';
    boardSelect.appendChild(noBoardOption);
    boardSelect.value = '';
    appendField(documentObject, boardSettings, '보드 선택', boardSelect);

    const newBoardDetails = documentObject.createElement('details');
    newBoardDetails.className = 'pinry-new-board-details';
    newBoardDetails.open = true;
    const newBoardSummary = documentObject.createElement('summary');
    newBoardSummary.textContent = '새 보드 만들기';
    newBoardDetails.appendChild(newBoardSummary);
    boardSettings.appendChild(newBoardDetails);

    const newBoardInput = documentObject.createElement('input');
    newBoardInput.id = 'pinry-new-board-name';
    newBoardInput.className = 'pinry-new-board-name';
    newBoardInput.type = 'text';
    appendField(documentObject, newBoardDetails, '새 보드 이름', newBoardInput);
    const newBoardPrivate = documentObject.createElement('input');
    newBoardPrivate.id = 'pinry-new-board-private';
    newBoardPrivate.className = 'pinry-new-board-private';
    newBoardPrivate.type = 'checkbox';
    appendCheckboxField(
      documentObject,
      newBoardDetails,
      '비공개 보드로 만들기',
      newBoardPrivate,
    );
    const createBoardButton = createButton(
      documentObject,
      '보드 만들기',
      'pinry-create-board',
    );
    newBoardDetails.appendChild(createBoardButton);

    const privateInput = documentObject.createElement('input');
    privateInput.id = 'pinry-private';
    privateInput.className = 'pinry-private-input';
    privateInput.type = 'checkbox';
    appendCheckboxField(
      documentObject,
      settingsFlow,
      '비공개 Pin으로 저장',
      privateInput,
      'pinry-private-field',
    );

    const details = documentObject.createElement('details');
    details.className = 'pinry-details';
    details.open = false;
    const summary = documentObject.createElement('summary');
    summary.textContent = '세부 정보';
    details.appendChild(summary);
    const descriptionInput = documentObject.createElement('textarea');
    descriptionInput.id = 'pinry-description';
    descriptionInput.className = 'pinry-description-input';
    descriptionInput.value = pageDefaults.description || '';
    appendField(documentObject, details, '설명', descriptionInput);
    const refererInput = documentObject.createElement('input');
    refererInput.id = 'pinry-referer';
    refererInput.className = 'pinry-referer-input';
    refererInput.type = 'url';
    refererInput.value = pageDefaults.referer || '';
    appendField(documentObject, details, '원본 페이지 URL', refererInput);
    settingsFlow.appendChild(details);

    const tagsInput = documentObject.createElement('input');
    tagsInput.id = 'pinry-tags';
    tagsInput.className = 'pinry-tags-input';
    tagsInput.type = 'text';
    const tagsField = appendField(
      documentObject,
      settingsFlow,
      '태그 (쉼표로 구분)',
      tagsInput,
      'pinry-tags-field',
    );
    const tagSuggestions = documentObject.createElement('div');
    tagSuggestions.className = 'pinry-tag-suggestions';
    tagsField.appendChild(tagSuggestions);

    const jobStatus = documentObject.createElement('div');
    jobStatus.className = 'pinry-job-status';
    jobStatus.setAttribute('aria-live', 'polite');
    const transportStatusElement = documentObject.createElement('div');
    transportStatusElement.className = 'pinry-transport-status';
    transportStatusElement.setAttribute('aria-live', 'polite');
    metadataHeader.appendChild(transportStatusElement);
    const jobItems = documentObject.createElement('div');
    jobItems.className = 'pinry-job-items';
    jobItems.setAttribute('aria-live', 'polite');
    const jobActions = documentObject.createElement('div');
    jobActions.className = 'pinry-job-actions';
    const retryButton = createButton(documentObject, '작업 재시도', 'pinry-job-retry');
    retryButton.style.display = 'none';
    const discardButton = createButton(documentObject, '작업 버리기', 'pinry-job-discard');
    discardButton.style.display = 'none';
    const openOptionsButton = createButton(
      documentObject,
      '설정 열기',
      'pinry-open-options',
    );
    openOptionsButton.style.display = 'none';
    const bootstrapRetryButton = createButton(
      documentObject,
      '설정 다시 시도',
      'pinry-bootstrap-retry',
    );
    bootstrapRetryButton.style.display = 'none';
    metadataBody.appendChild(jobStatus);
    metadataBody.appendChild(jobItems);
    jobActions.appendChild(retryButton);
    jobActions.appendChild(discardButton);
    jobActions.appendChild(openOptionsButton);
    jobActions.appendChild(bootstrapRetryButton);
    metadataBody.appendChild(jobActions);
    metadataPanel.appendChild(metadataBody);

    const metadataFooter = documentObject.createElement('div');
    metadataFooter.className = 'pinry-metadata-footer';
    metadataFooter.appendChild(closeButton);
    metadataFooter.appendChild(submit);
    metadataPanel.appendChild(metadataFooter);
    workspace.appendChild(metadataPanel);

    const candidateCanvas = documentObject.createElement('section');
    candidateCanvas.className = 'pinry-candidate-canvas';
    const candidateHeader = documentObject.createElement('div');
    candidateHeader.className = 'pinry-candidate-header';
    const candidateTitle = documentObject.createElement('h2');
    candidateTitle.className = 'pinry-candidate-title';
    candidateTitle.textContent = '이미지 후보';
    const candidateSummary = documentObject.createElement('div');
    candidateSummary.className = 'pinry-candidate-summary';
    candidateSummary.setAttribute('aria-live', 'polite');
    candidateSummary.textContent = '0개 발견 · 0개 선택';
    candidateHeader.appendChild(candidateTitle);
    candidateHeader.appendChild(candidateSummary);
    candidateCanvas.appendChild(candidateHeader);
    workspace.appendChild(candidateCanvas);

    const loading = documentObject.createElement('div');
    loading.className = 'pinry-loading';
    loading.setAttribute('aria-live', 'polite');
    loading.textContent = '이미지 후보를 찾는 중입니다.';
    candidateCanvas.appendChild(loading);
    const grid = documentObject.createElement('div');
    grid.className = 'pinry-candidate-grid';
    grid.setAttribute('role', 'listbox');
    grid.setAttribute('aria-multiselectable', 'true');
    grid.setAttribute('aria-label', '이미지 후보');
    grid.setAttribute('aria-live', 'polite');
    candidateCanvas.appendChild(grid);
    mountRoot.appendChild(overlay);

    let controller;
    let candidateTotal = 0;
    let currentBatchId = null;
    let submissionInFlight = false;
    let jobMutationInFlight = false;
    let createBoardInFlight = false;
    let bootstrapReady = false;
    let activeBootstrap = null;
    let availableTags = [];
    let availableBoardValues = new Set();
    const formState = {
      boardValue: '',
      tagsValue: '',
      privateValue: false,
      descriptionValue: descriptionInput.value,
      refererValue: refererInput.value,
      newBoardName: '',
      newBoardPrivate: false,
    };
    const trustedCheckboxActivations = new WeakSet();
    let renderedJob = null;
    let viewPinsButton = null;
    const refreshFlights = new Map();
    let bootstrapInFlight = false;
    let bootstrapAttempt = 0;
    let pollTimer = null;
    let transportStatus = 'connected';
    const setPollTimeout = options.setTimeoutImpl
      || (typeof scope.setTimeout === 'function' && scope.setTimeout.bind(scope));
    const clearPollTimeout = options.clearTimeoutImpl
      || (typeof scope.clearTimeout === 'function' && scope.clearTimeout.bind(scope));
    const pollIntervalMs = Math.max(
      500,
      Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 1000,
    );
    function isCurrent() {
      return !disposed && overlay.parentNode === mountRoot;
    }

    async function request(innerRequest) {
      return requestTransport.request(innerRequest);
    }

    function isTrustedUserEvent(event) {
      return Boolean(event && event.isTrusted === true);
    }

    function renderTransportStatus(event) {
      const state = event.status === 'connected' ? 'connected'
        : event.status === 'reconnecting' ? 'reconnecting' : 'terminal';
      transportStatusElement.setAttribute('data-state', state);
      transportStatusElement.textContent = state === 'connected' ? '연결됨'
        : state === 'reconnecting' ? '재연결 중…'
          : userMessageForCode(event.code || 'overlay_connection_lost');
    }

    function isTransientTransportFailure(code) {
      return code === 'overlay_connection_lost' && transportStatus === 'reconnecting';
    }

    const cleanupCallbacks = [];
    function listen(target, type, listener) {
      target.addEventListener(type, listener);
      cleanupCallbacks.push(() => target.removeEventListener(type, listener));
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()();
    }

    function close() {
      if (disposed) return;
      dispose();
      if (!closeNotified) {
        closeNotified = true;
        options.onClose();
      }
    }

    function stopPolling() {
      if (pollTimer !== null && clearPollTimeout) clearPollTimeout(pollTimer);
      pollTimer = null;
    }

    function schedulePoll() {
      if (!currentBatchId || !isCurrent() || pollTimer !== null || !setPollTimeout) return;
      const batchId = currentBatchId;
      pollTimer = setPollTimeout(() => {
        pollTimer = null;
        if (isCurrent() && currentBatchId === batchId) refreshJob();
      }, pollIntervalMs);
    }

    function handleKeyup(event) {
      if (!isTrustedUserEvent(event)) return;
      composedTarget(event);
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' || event.keyCode === 27) close();
    }

    function isTextEntryEvent(event) {
      const path = event && typeof event.composedPath === 'function'
        ? event.composedPath() : [composedTarget(event)];
      for (const element of path) {
        if (!element || element === mountRoot) break;
        const tagName = typeof element.tagName === 'string' ? element.tagName : '';
        if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION'].includes(tagName)) return true;
        if (element.isContentEditable === true) return true;
        if (typeof element.getAttribute === 'function') {
          const editable = element.getAttribute('contenteditable');
          if (editable === '' || editable === 'true') return true;
        }
      }
      return false;
    }

    function focusableElements() {
      const result = [];
      function visit(parent, ancestorHidden) {
        for (const element of Array.from(parent.children || [])) {
          const hidden = ancestorHidden || element.hidden === true
            || (element.style && element.style.display === 'none');
          const tagName = typeof element.tagName === 'string' ? element.tagName : '';
          const tabIndex = typeof element.tabIndex === 'number' ? element.tabIndex : -1;
          const focusableTag = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tagName);
          const ariaHidden = typeof element.getAttribute === 'function'
            && element.getAttribute('aria-hidden') === 'true';
          if (!hidden && !ariaHidden && element.disabled !== true
            && (focusableTag || tabIndex >= 0)) result.push(element);
          if (tagName === 'DETAILS' && element.open !== true) {
            const summaryElement = Array.from(element.children || [])
              .find((child) => child.tagName === 'SUMMARY');
            if (summaryElement && !result.includes(summaryElement)) result.push(summaryElement);
          } else {
            visit(element, hidden);
          }
        }
      }
      visit(overlay, false);
      return result;
    }

    function trapFocus(event) {
      const focusable = focusableElements();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = mountRoot.activeElement || documentObject.activeElement;
      if (event.shiftKey && (active === first || !active)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !active)) {
        event.preventDefault();
        first.focus();
      }
    }

    function handleShadowKeydown(event) {
      if (!isTrustedUserEvent(event)) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' || event.keyCode === 27) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'Tab') {
        trapFocus(event);
        return;
      }
      if ((event.ctrlKey || event.metaKey)
        && typeof event.key === 'string'
        && event.key.toLowerCase() === 'a'
        && !isTextEntryEvent(event)
        && controller.model) {
        event.preventDefault();
        controller.model.selectAll();
        updateSelection();
      }
    }

    function toggleCandidate(id, event) {
      if (!isTrustedUserEvent(event) || !controller.model || !isCurrent()) return;
      controller.model.toggleWithModifiers(id, {
        shiftKey: Boolean(event && event.shiftKey),
        ctrlKey: Boolean(event && event.ctrlKey),
        metaKey: Boolean(event && event.metaKey),
      });
      updateSelection();
    }

    function updateSelection() {
      const selectedIds = new Set(controller.model ? controller.model.selected() : []);
      for (const card of controller.cards) {
        const selected = selectedIds.has(card.getAttribute('data-candidate-id'));
        card.setAttribute('aria-selected', String(selected));
      }
      for (const checkbox of controller.checkboxes) {
        const selected = selectedIds.has(checkbox.getAttribute('data-candidate-id'));
        checkbox.checked = selected;
        checkbox.textContent = selected ? '✓' : '';
      }
      const count = selectedIds.size;
      selectionCount.textContent = `${count}개 선택`;
      candidateSummary.textContent = `${candidateTotal}개 발견 · ${count}개 선택`;
      const submitText = count > 0
        ? `선택한 ${count}개 Pin 만들기`
        : '선택한 Pin 만들기';
      const submitDisabled = count === 0 || !bootstrapReady
        || submissionInFlight || createBoardInFlight || currentBatchId !== null
        || transportStatus !== 'connected';
      toolbarSubmit.setAttribute('aria-label', submitText);
      toolbarSubmit.textContent = submitText;
      toolbarSubmit.disabled = submitDisabled;
      submit.textContent = submitText;
      submit.disabled = submitDisabled;
      createBoardButton.disabled = !bootstrapReady || createBoardInFlight
        || submissionInFlight || currentBatchId !== null || transportStatus !== 'connected';
    }

    function updateJobMutationControls() {
      const locked = jobMutationInFlight || transportStatus !== 'connected';
      retryButton.disabled = locked;
      discardButton.disabled = locked;
    }

    function hasCurrentCompletedJob() {
      return Boolean(renderedJob && renderedJob.job_state === 'completed'
        && activeBootstrap && activeBootstrap.configured === true
        && activeBootstrap.hasPermission === true
        && renderedJob.server_origin === activeBootstrap.origin
        && renderedJob.server_username === activeBootstrap.username);
    }

    function syncCreatedPinsButton() {
      if (!hasCurrentCompletedJob()) {
        if (viewPinsButton) viewPinsButton.remove();
        viewPinsButton = null;
        return;
      }
      if (viewPinsButton) return;
      viewPinsButton = createButton(
        documentObject,
        '생성한 Pin 보기',
        'pinry-view-created-pins',
      );
      listen(viewPinsButton, 'click', (event) => {
        if (!isTrustedUserEvent(event) || !isCurrent() || !hasCurrentCompletedJob()) return;
        openCreatedPins(scope, activeBootstrap);
      });
      jobActions.appendChild(viewPinsButton);
    }

    function renderJob(job) {
      if (!isCurrent() || !job || job.batch_id !== currentBatchId
        || !Array.isArray(job.items)) return;
      renderedJob = job;
      const userSummary = summarizeJobForUser(job);
      jobStatus.textContent = userSummary.final
        ? `성공 ${userSummary.success}개 · 실패 ${userSummary.failed}개`
        : `성공 ${userSummary.success}개 · 처리 중 ${userSummary.pending}개`
          + ` · 재시도 필요 ${userSummary.retryNeeded}개`;
      while (jobItems.children.length > 0) jobItems.removeChild(jobItems.children[0]);
      job.items.forEach((item, index) => {
        const status = documentObject.createElement('div');
        status.className = 'pinry-job-item-status';
        const statusCode = item && [
          'pending', 'created', 'replayed', 'failed', 'conflict', 'unknown',
        ].includes(item.status) ? item.status : 'unknown';
        const errorMessage = item && item.error && typeof item.error.code === 'string'
          && /^[a-z0-9_]{1,64}$/.test(item.error.code)
          ? ` · ${userMessageForCode(item.error.code)}` : '';
        status.textContent = `${index + 1}. ${ITEM_STATUS_LABELS[statusCode]}${errorMessage}`;
        jobItems.appendChild(status);
      });
      retryButton.style.display = job.job_state === 'paused' ? '' : 'none';
      discardButton.style.display = job.job_state === 'completed' ? 'none' : '';
      syncCreatedPinsButton();
      updateJobMutationControls();
      if (job.job_state === 'running') schedulePoll();
      else stopPolling();
      updateSelection();
    }

    function showJobRecovery(code, batchId) {
      if (!isCurrent() || currentBatchId !== batchId) return;
      if (isTransientTransportFailure(code)) return;
      stopPolling();
      jobStatus.textContent = userMessageForCode(code);
      currentBatchId = null;
      renderedJob = null;
      syncCreatedPinsButton();
      bootstrapReady = false;
      retryButton.style.display = 'none';
      discardButton.style.display = 'none';
      bootstrapRetryButton.textContent = '작업 복구';
      bootstrapRetryButton.style.display = '';
      updateSelection();
    }

    async function refreshJob(force = false) {
      if (!currentBatchId || !isCurrent()) return;
      const batchId = currentBatchId;
      if (refreshFlights.has(batchId) && !force) return;
      const requestId = {};
      refreshFlights.set(batchId, requestId);
      try {
        const response = await request({
          type: 'pinry:get-job',
          batch_id: batchId,
        });
        if (!isCurrent() || currentBatchId !== batchId
          || refreshFlights.get(batchId) !== requestId) return;
        if (response && response.ok && response.job) renderJob(response.job);
        else {
          showJobRecovery(response && response.code
            ? response.code : 'job_status_unavailable', batchId);
        }
      } catch (_error) {
        showJobRecovery('job_status_unavailable', batchId);
      } finally {
        if (refreshFlights.get(batchId) === requestId) refreshFlights.delete(batchId);
      }
    }

    async function submitSelection(event) {
      if (!isTrustedUserEvent(event) || !controller.model || !controller.result || !isCurrent()
        || !bootstrapReady || submissionInFlight || createBoardInFlight || currentBatchId
        || transportStatus !== 'connected') return;
      const selected = new Set(controller.model.selected());
      const candidates = controller.result.candidates
        .filter((candidate) => selected.has(candidate.id))
        .map((candidate) => ({ url: candidate.url }));
      if (candidates.length === 0) return;
      submissionInFlight = true;
      updateSelection();
      jobStatus.textContent = userMessageForCode('creating');
      try {
        const response = await request({
          type: 'pinry:create-job',
          candidates,
          expected_server: {
            origin: activeBootstrap && activeBootstrap.origin,
            username: activeBootstrap && activeBootstrap.username,
          },
          metadata: {
            board_ids: formState.boardValue === '' ? [] : [Number(formState.boardValue)],
            tags: formState.tagsValue.split(',').map((tag) => tag.trim()).filter(Boolean),
            private: formState.privateValue,
            referer: formState.refererValue,
            description: formState.descriptionValue,
          },
        });
        if (!response || !response.ok || typeof response.batch_id !== 'string') {
          const code = response && response.code ? response.code : 'job_create_failed';
          if (isTransientTransportFailure(code)) return;
          jobStatus.textContent = userMessageForCode(code);
          if (code === 'job_already_exists') {
            bootstrapReady = false;
            updateSelection();
            await loadBootstrap();
          } else if (code === 'server_configuration_changed') {
            bootstrapReady = false;
            updateSelection();
            await loadBootstrap();
          }
          return;
        }
        if (!isCurrent()) return;
        currentBatchId = response.batch_id;
        await refreshJob();
      } catch (_error) {
        if (isCurrent()) jobStatus.textContent = userMessageForCode('job_create_failed');
      } finally {
        submissionInFlight = false;
        if (isCurrent()) updateSelection();
      }
    }

    async function createBoard(event) {
      if (!isTrustedUserEvent(event) || !isCurrent() || !bootstrapReady || createBoardInFlight
        || submissionInFlight || currentBatchId !== null || transportStatus !== 'connected') return;
      const name = formState.newBoardName.trim();
      if (name.length === 0) {
        jobStatus.textContent = userMessageForCode('invalid_board_request');
        return;
      }
      createBoardInFlight = true;
      createBoardButton.disabled = true;
      updateSelection();
      try {
        const response = await request({
          type: 'pinry:create-board',
          name,
          private: formState.newBoardPrivate,
          expected_server: {
            origin: activeBootstrap && activeBootstrap.origin,
            username: activeBootstrap && activeBootstrap.username,
          },
        });
        if (!isCurrent()) return;
        const board = response && {
          id: response.id,
          name: response.name,
        };
        if (response && response.ok === true
          && Number.isSafeInteger(board.id) && board.id > 0
          && typeof board.name === 'string') {
          appendBoardOption(board, { selected: true });
          jobStatus.textContent = '보드를 만들었습니다.';
          return;
        }
        const code = response && typeof response.code === 'string'
          ? response.code : 'board_create_failed';
        if (isTransientTransportFailure(code)) return;
        jobStatus.textContent = userMessageForCode(code);
        await loadBootstrap();
      } catch (_error) {
        if (!isCurrent()) return;
        jobStatus.textContent = userMessageForCode('network_error');
        await loadBootstrap();
      } finally {
        createBoardInFlight = false;
        if (isCurrent()) {
          createBoardButton.disabled = false;
          updateSelection();
        }
      }
    }

    function renderResult(result) {
      if (!isCurrent()) return;
      loading.remove();
      controller.result = result;
      candidateTotal = result.totalCandidates;
      controller.model = new selectionApi.SelectionModel(
        result.candidates.map((candidate) => candidate.id),
      );

      if (result.truncated) {
        const limitMessage = documentObject.createElement('div');
        limitMessage.className = 'pinry-limit-message';
        limitMessage.textContent = '이미지 후보가 많아 처음 500개만 표시합니다.';
        candidateCanvas.appendChild(limitMessage);
      }

      result.candidates.forEach((candidate, index) => {
        const tile = documentObject.createElement('div');
        tile.className = 'pinry-candidate';
        tile.setAttribute('data-candidate-id', candidate.id);
        tile.setAttribute('role', 'option');
        tile.setAttribute('aria-selected', 'false');
        tile.setAttribute(
          'aria-label',
          `이미지 ${index + 1}, ${candidate.width}×${candidate.height}`,
        );
        tile.tabIndex = 0;
        tile.setAttribute('tabindex', '0');
        listen(tile, 'click', (event) => {
          toggleCandidate(candidate.id, event);
        });
        listen(tile, 'keydown', (event) => {
          if (event.isComposing || event.keyCode === 229
            || (event.key !== 'Enter' && event.key !== ' ')) return;
          if (!controller.model || !isCurrent()) return;
          event.preventDefault();
          toggleCandidate(candidate.id, event);
        });

        const number = documentObject.createElement('span');
        number.className = 'pinry-candidate-number';
        number.textContent = String(index + 1);
        tile.appendChild(number);

        const checkbox = documentObject.createElement('span');
        checkbox.className = 'pinry-candidate-checkbox';
        checkbox.setAttribute('data-candidate-id', candidate.id);
        checkbox.setAttribute('aria-hidden', 'true');
        checkbox.checked = false;
        tile.appendChild(checkbox);
        controller.checkboxes.push(checkbox);

        function appendPreviewPlaceholder(message) {
          const placeholder = documentObject.createElement('div');
          placeholder.className = 'pinry-preview-placeholder';
          placeholder.textContent = message;
          tile.appendChild(placeholder);
        }
        if (typeof candidate.url === 'string' && candidate.url.startsWith('https://')) {
          const image = documentObject.createElement('img');
          image.className = 'pinry-candidate-image';
          image.referrerPolicy = 'no-referrer';
          image.src = candidate.url;
          image.alt = '';
          image.onerror = () => {
            if (!isCurrent()) return;
            if (image.parentNode) image.parentNode.removeChild(image);
            appendPreviewPlaceholder('미리보기를 불러오지 못했습니다.');
          };
          tile.appendChild(image);
        } else {
          appendPreviewPlaceholder('HTTP 미리보기');
        }

        const dimensions = documentObject.createElement('div');
        dimensions.className = 'pinry-candidate-dimensions';
        dimensions.textContent = `${candidate.width}\u00d7${candidate.height}`;
        tile.appendChild(dimensions);
        grid.appendChild(tile);
        controller.cards.push(tile);
      });
      updateSelection();
      if (isCurrent() && typeof selectAll.focus === 'function') selectAll.focus();
    }

    function renderFailure() {
      if (!isCurrent()) return;
      loading.textContent = '이미지 후보를 찾지 못했습니다.';
      if (typeof closeButton.focus === 'function') closeButton.focus();
    }

    listen(selectAll, 'click', (event) => {
      if (!isTrustedUserEvent(event) || !controller.model || !isCurrent()) return;
      controller.model.selectAll();
      updateSelection();
    });
    listen(clearAll, 'click', (event) => {
      if (!isTrustedUserEvent(event) || !controller.model || !isCurrent()) return;
      controller.model.clearAll();
      updateSelection();
    });
    listen(toolbarSubmit, 'click', submitSelection);
    listen(submit, 'click', submitSelection);
    listen(createBoardButton, 'click', createBoard);
    function handleCheckboxClick(event, input, stateKey) {
      if (!isTrustedUserEvent(event)) {
        event.preventDefault();
        if (typeof event.stopImmediatePropagation === 'function') {
          event.stopImmediatePropagation();
        }
        input.checked = formState[stateKey];
        return;
      }
      trustedCheckboxActivations.add(input);
    }
    function applyCheckboxChange(event, input, stateKey) {
      const activated = trustedCheckboxActivations.has(input);
      trustedCheckboxActivations.delete(input);
      if (!activated || !isTrustedUserEvent(event) || event.defaultPrevented === true) {
        input.checked = formState[stateKey];
        return;
      }
      formState[stateKey] = input.checked === true;
    }
    listen(boardSelect, 'change', (event) => {
      if (!isTrustedUserEvent(event)) return;
      if (boardSelect.value === '' || availableBoardValues.has(boardSelect.value)) {
        formState.boardValue = boardSelect.value;
      } else {
        boardSelect.value = formState.boardValue;
      }
    });
    listen(tagsInput, 'input', (event) => {
      if (!isTrustedUserEvent(event)) return;
      formState.tagsValue = tagsInput.value;
      renderTagSuggestions();
    });
    listen(privateInput, 'click', (event) => {
      handleCheckboxClick(event, privateInput, 'privateValue');
    });
    listen(privateInput, 'change', (event) => {
      applyCheckboxChange(event, privateInput, 'privateValue');
    });
    listen(descriptionInput, 'input', (event) => {
      if (isTrustedUserEvent(event)) formState.descriptionValue = descriptionInput.value;
    });
    listen(refererInput, 'input', (event) => {
      if (isTrustedUserEvent(event)) formState.refererValue = refererInput.value;
    });
    listen(newBoardInput, 'input', (event) => {
      if (isTrustedUserEvent(event)) formState.newBoardName = newBoardInput.value;
    });
    listen(newBoardPrivate, 'click', (event) => {
      handleCheckboxClick(event, newBoardPrivate, 'newBoardPrivate');
    });
    listen(newBoardPrivate, 'change', (event) => {
      applyCheckboxChange(event, newBoardPrivate, 'newBoardPrivate');
    });
    listen(retryButton, 'click', async (event) => {
      if (!isTrustedUserEvent(event)
        || !currentBatchId || !isCurrent() || jobMutationInFlight
        || transportStatus !== 'connected') return;
      const batchId = currentBatchId;
      jobMutationInFlight = true;
      updateJobMutationControls();
      stopPolling();
      try {
        await request({
          type: 'pinry:retry-job',
          batch_id: batchId,
        });
        if (isCurrent() && currentBatchId === batchId) await refreshJob();
      } catch (_error) {
        if (isCurrent()) jobStatus.textContent = userMessageForCode('job_retry_failed');
      } finally {
        jobMutationInFlight = false;
        if (isCurrent()) updateJobMutationControls();
      }
    });
    listen(discardButton, 'click', async (event) => {
      if (!isTrustedUserEvent(event)
        || !currentBatchId || !isCurrent() || jobMutationInFlight
        || transportStatus !== 'connected'
        || typeof scope.confirm !== 'function'
        || !scope.confirm('이 작업을 버릴까요?')) return;
      const batchId = currentBatchId;
      jobMutationInFlight = true;
      updateJobMutationControls();
      stopPolling();
      try {
        const response = await request({
          type: 'pinry:discard-job',
          batch_id: batchId,
        });
        if (!isCurrent() || currentBatchId !== batchId) return;
        if (!response || response.ok !== true) {
          const code = response && response.code ? response.code : 'job_discard_failed';
          if (isTransientTransportFailure(code)) return;
          jobStatus.textContent = userMessageForCode(code);
          schedulePoll();
          return;
        }
        stopPolling();
        currentBatchId = null;
        renderedJob = null;
        syncCreatedPinsButton();
        jobStatus.textContent = userMessageForCode('discarded');
        while (jobItems.children.length > 0) jobItems.removeChild(jobItems.children[0]);
        retryButton.style.display = 'none';
        discardButton.style.display = 'none';
        updateSelection();
      } catch (_error) {
        if (isCurrent() && currentBatchId === batchId) {
          jobStatus.textContent = userMessageForCode('job_discard_failed');
          schedulePoll();
        }
      } finally {
        jobMutationInFlight = false;
        if (isCurrent()) updateJobMutationControls();
      }
    });
    listen(openOptionsButton, 'click', async (event) => {
      if (!isTrustedUserEvent(event) || !isCurrent()) return;
      try {
        await request({ type: 'pinry:open-options' });
      } catch (_error) {
        if (isCurrent()) jobStatus.textContent = userMessageForCode('open_options_failed');
      }
    });
    listen(bootstrapRetryButton, 'click', (event) => {
      if (!isTrustedUserEvent(event)) return;
      loadBootstrap();
    });
    function handleClose(event) {
      if (isTrustedUserEvent(event)) close();
    }
    function handleToolbarClick(event) {
      if (!isTrustedUserEvent(event)) return;
      const eventPath = typeof event.composedPath === 'function'
        ? event.composedPath() : [event.target];
      if (eventPath.some((element) => (
        ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'SUMMARY'].includes(element?.tagName)
      ))) return;
      close();
    }
    listen(toolbar, 'click', handleToolbarClick);
    listen(toolbarBrand, 'click', handleToolbarClick);
    listen(toolbarCloseButton, 'click', handleClose);
    listen(closeButton, 'click', handleClose);
    listen(mountRoot, 'keydown', handleShadowKeydown);
    listen(documentObject, 'keyup', handleKeyup);

    controller = {
      cards: [],
      checkboxes: [],
      element: overlay,
      model: null,
      ready: null,
      result: null,
      focus() {
        if (disposed) return false;
        const target = focusableElements().find((element) => element.disabled !== true) || overlay;
        if (typeof target.focus !== 'function') return false;
        target.focus();
        return true;
      },
      dispose,
    };
    cleanupCallbacks.push(() => stopPolling());
    const unsubscribe = requestTransport.subscribe((event) => {
      if (!isCurrent()) return;
      if (!event || !['connected', 'reconnecting', 'terminal'].includes(event.status)) return;
      const wasReconnecting = transportStatus === 'reconnecting';
      transportStatus = event.status;
      renderTransportStatus(event);
      if (event.status === 'reconnecting') {
        updateSelection();
        return;
      }
      if (event.status === 'terminal') {
        stopPolling();
        updateSelection();
        updateJobMutationControls();
        return;
      }
      if (event.status === 'connected' && wasReconnecting && isCurrent()) {
        loadBootstrap(true);
        if (currentBatchId) refreshJob(true);
      }
      updateSelection();
    });
    if (typeof unsubscribe === 'function') cleanupCallbacks.push(unsubscribe);

    function showBootstrapFailure(code) {
      if (!isCurrent()) return;
      if (isTransientTransportFailure(code)) return;
      activeBootstrap = null;
      syncCreatedPinsButton();
      bootstrapReady = false;
      jobStatus.textContent = userMessageForCode(code);
      openOptionsButton.style.display = '';
      bootstrapRetryButton.style.display = '';
      updateSelection();
    }

    function appendBoardOption(board, { selected = false } = {}) {
      const value = String(board.id);
      let option = Array.from(boardSelect.children)
        .find((item) => item.value === value);
      if (!option) {
        option = documentObject.createElement('option');
        option.value = value;
        boardSelect.appendChild(option);
      }
      option.textContent = board.name;
      availableBoardValues.add(value);
      if (selected) {
        formState.boardValue = value;
        boardSelect.value = value;
      }
      return option;
    }

    function renderTagSuggestions() {
      while (tagSuggestions.children.length > 0) {
        tagSuggestions.removeChild(tagSuggestions.children[0]);
      }
      const fragments = formState.tagsValue.split(',');
      const fragment = fragments[fragments.length - 1].trim().toLocaleLowerCase();
      availableTags.filter((tag) => (
        tag.trim().toLocaleLowerCase().includes(fragment)
      )).slice(0, 10).forEach((rawTag) => {
        const tag = rawTag.trim();
        const suggestion = createButton(
          documentObject,
          tag,
          'pinry-tag-suggestion',
        );
        listen(suggestion, 'click', (event) => {
          if (!isTrustedUserEvent(event)) return;
          const inputValues = formState.tagsValue.split(',');
          inputValues.pop();
          const values = [];
          inputValues.forEach((value) => {
            const normalized = value.trim();
            if (normalized && !values.includes(normalized)) values.push(normalized);
          });
          if (!values.includes(tag)) values.push(tag);
          formState.tagsValue = values.join(', ');
          tagsInput.value = formState.tagsValue;
          renderTagSuggestions();
        });
        tagSuggestions.appendChild(suggestion);
      });
    }

    function applyBootstrap(bootstrap) {
      activeBootstrap = null;
      syncCreatedPinsButton();
      if (!bootstrap || typeof bootstrap !== 'object') {
        showBootstrapFailure('bootstrap_unavailable');
        return;
      }
      if (!currentBatchId && bootstrap.current_job
        && typeof bootstrap.current_job.batch_id === 'string') {
        currentBatchId = bootstrap.current_job.batch_id;
        refreshJob();
      }
      if (bootstrap.configured !== true) {
        showBootstrapFailure('server_not_configured');
        return;
      }
      if (bootstrap.hasPermission !== true) {
        showBootstrapFailure('host_permission_required');
        return;
      }
      if (!Array.isArray(bootstrap.boards) || !Array.isArray(bootstrap.tags)) {
        showBootstrapFailure('bootstrap_unavailable');
        return;
      }
      const previousBoard = formState.boardValue;
      availableTags = bootstrap.tags.slice();
      activeBootstrap = bootstrap;
      syncCreatedPinsButton();
      bootstrapReady = true;
      openOptionsButton.style.display = 'none';
      bootstrapRetryButton.textContent = '설정 다시 시도';
      bootstrapRetryButton.style.display = 'none';
      while (boardSelect.children.length > 0) {
        boardSelect.removeChild(boardSelect.children[0]);
      }
      availableBoardValues = new Set();
      const sentinel = documentObject.createElement('option');
      sentinel.value = '';
      sentinel.textContent = '보드 지정 안 함';
      boardSelect.appendChild(sentinel);
      bootstrap.boards.forEach((board) => appendBoardOption(board));
      formState.boardValue = availableBoardValues.has(previousBoard) ? previousBoard : '';
      boardSelect.value = formState.boardValue;
      renderTagSuggestions();
      updateSelection();
    }

    async function loadBootstrap(force = false) {
      if (!isCurrent() || (bootstrapInFlight && !force)) return;
      bootstrapInFlight = true;
      activeBootstrap = null;
      syncCreatedPinsButton();
      bootstrapReady = false;
      updateSelection();
      bootstrapAttempt += 1;
      const attempt = bootstrapAttempt;
      try {
        const response = await request({ type: 'pinry:get-bootstrap' });
        if (!isCurrent() || attempt !== bootstrapAttempt) return;
        if (!response || response.ok !== true || !response.bootstrap) {
          showBootstrapFailure(response && typeof response.code === 'string'
            ? response.code : 'bootstrap_unavailable');
          return;
        }
        applyBootstrap(response.bootstrap);
      } catch (_error) {
        if (isCurrent() && attempt === bootstrapAttempt) {
          showBootstrapFailure('bootstrap_unavailable');
        }
      } finally {
        if (attempt === bootstrapAttempt) bootstrapInFlight = false;
      }
    }

    loadBootstrap();
    controller.ready = Promise.resolve(options.candidatePromise).then((result) => {
      renderResult(result);
      return result;
    }, (failure) => {
      renderFailure(failure && failure.code);
      return null;
    });
    return controller;
  }

  return { openOverlay, summarizeJobForUser };
}));
