(function exposeOptions(root, factory) {
  let originApi = root.PinryOrigin;
  if (!originApi && typeof module === 'object' && module.exports) {
    originApi = require('./origin.js');
  }
  if (!originApi) throw new Error('origin_module_unavailable');

  const api = factory(root, originApi);
  root.PinryOptions = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document && root.chrome) api.initializeOptions(root);
}(globalThis, function buildOptionsApi(root, originApi) {
  'use strict';

  const PENDING_KEY = 'pinry.server.pending';

  function createAttemptId(cryptoImpl = root.crypto) {
    if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') {
      return cryptoImpl.randomUUID();
    }
    if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoImpl.getRandomValues(bytes);
      return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    }
    throw originApi.codeError('attempt_id_unavailable');
  }

  function safeResponseCode(response) {
    if (response && typeof response.code === 'string' && /^[a-z0-9_]+$/.test(response.code)) {
      return response.code;
    }
    return 'server_validation_failed';
  }

  const STATUS_MESSAGES = Object.freeze({
    saved: '서버 인증 정보를 확인했습니다.',
    revalidated: '연결 상태를 다시 확인했습니다.',
    deleting: '인증 정보를 삭제하는 중입니다.',
    deleted: '인증 정보를 삭제했습니다.',
    invalid_server_origin: '서버 주소를 확인하세요.',
    invalid_token: 'API token을 입력하세요.',
    insecure_http_confirmation_required: 'HTTP 평문 전송 동의가 필요합니다.',
    host_permission_denied: '서버 접근 권한이 필요합니다.',
    host_permission_required: '저장된 서버 접근 권한을 확인하세요.',
    server_identity_changed: '저장된 사용자와 서버의 사용자가 일치하지 않습니다.',
    server_configuration_changed: '서버 설정이 변경되었습니다. 다시 확인하세요.',
    network_error: '서버에 연결하지 못했습니다.',
    profile_request_failed: '서버 프로필을 확인하지 못했습니다.',
    invalid_profile_response: '서버 응답을 확인하지 못했습니다.',
    token_mismatch: 'API token이 서버 사용자와 일치하지 않습니다.',
    pending_storage_failed: '인증 정보를 임시 저장하지 못했습니다.',
    permission_rollback_failed: '서버 접근 권한을 정리하지 못했습니다.',
    webextension_api_error: '브라우저 기능을 사용할 수 없습니다.',
    attempt_id_unavailable: '안전한 인증 시도를 시작하지 못했습니다.',
    server_validation_failed: '서버 인증을 확인하지 못했습니다.',
  });

  function normalizeServerState(state) {
    const prototype = state && typeof state === 'object'
      ? Object.getPrototypeOf(state) : null;
    const keys = prototype === Object.prototype || prototype === null
      ? Object.keys(state).sort() : [];
    const exactKeys = JSON.stringify(keys)
      === JSON.stringify(['configured', 'hasPermission', 'origin', 'username']);
    if (!exactKeys
      || typeof state.configured !== 'boolean'
      || typeof state.hasPermission !== 'boolean') {
      throw originApi.codeError('server_validation_failed');
    }
    if (!state.configured) {
      if (state.origin !== null || state.username !== null || state.hasPermission !== false) {
        throw originApi.codeError('server_validation_failed');
      }
      return {
        configured: false,
        origin: null,
        username: null,
        hasPermission: false,
      };
    }
    let normalizedOrigin;
    try {
      normalizedOrigin = originApi.normalizeServerOrigin(state.origin);
    } catch (error) {
      throw originApi.codeError('server_validation_failed');
    }
    if (normalizedOrigin !== state.origin
      || typeof state.username !== 'string'
      || state.username === '') {
      throw originApi.codeError('server_validation_failed');
    }
    return {
      configured: true,
      origin: state.origin,
      username: state.username,
      hasPermission: state.hasPermission,
    };
  }

  async function requestServerState(chromeApi, type) {
    const response = await originApi.callWebExtension(
      chromeApi.runtime.sendMessage,
      chromeApi.runtime,
      [{ type }],
      chromeApi.runtime,
    );
    if (!response || response.ok !== true) {
      throw originApi.codeError(safeResponseCode(response));
    }
    return normalizeServerState(response.state);
  }

  function getServerState(chromeApi) {
    return requestServerState(chromeApi, 'pinry:get-server-state');
  }

  function revalidateServer(chromeApi) {
    return requestServerState(chromeApi, 'pinry:revalidate-server');
  }

  function renderServerState(elements, state) {
    elements.serverState.dataset.phase = state.phase;
    if (state.phase === 'loading') {
      elements.serverConnectionStatus.textContent = '상태 확인 중';
      return;
    }
    if (state.phase === 'unavailable') {
      elements.serverConnectionStatus.textContent = '상태 확인 불가';
      return;
    }

    if (!state.configured) {
      elements.serverConnectionStatus.textContent = '연결되지 않음';
      elements.serverOrigin.textContent = '';
      elements.serverUsername.textContent = '';
      elements.serverPermission.textContent = '';
      elements.serverTokenState.textContent = '저장된 API 토큰 없음';
      return;
    }

    elements.serverConnectionStatus.textContent = '연결 정보 저장됨';
    elements.serverOrigin.textContent = `서버: ${state.origin}`;
    elements.serverUsername.textContent = `사용자: ${state.username}`;
    elements.serverPermission.textContent = state.hasPermission
      ? '서버 접근 권한 있음' : '서버 접근 권한 없음';
    elements.serverTokenState.textContent = 'API 토큰 저장됨';
  }

  function updateSaveEligibility(originInput, tokenInput, submitButton) {
    const eligible = originInput.value.trim() !== '' && tokenInput.value !== '';
    submitButton.disabled = !eligible;
    return eligible;
  }

  async function saveServerSettings({
    chromeApi,
    originInput,
    token,
    allowInsecureHttp,
    attemptId,
    now = Date.now,
    cryptoImpl,
  }) {
    const origin = originApi.normalizeServerOrigin(originInput);
    if (typeof token !== 'string' || token === '') {
      throw originApi.codeError('invalid_token');
    }
    if (origin.startsWith('http://') && allowInsecureHttp !== true) {
      throw originApi.codeError('insecure_http_confirmation_required');
    }

    const permission = { origins: [originApi.permissionPattern(origin)] };
    const containsPromise = originApi.callWebExtension(
      chromeApi.permissions.contains,
      chromeApi.permissions,
      [permission],
      chromeApi.runtime,
    );
    const requestPromise = originApi.callWebExtension(
      chromeApi.permissions.request,
      chromeApi.permissions,
      [permission],
      chromeApi.runtime,
    );
    const [permissionWasPresent, granted] = await Promise.all([
      containsPromise,
      requestPromise,
    ]);
    if (!granted) throw originApi.codeError('host_permission_denied');

    const pending = {
      schemaVersion: 1,
      attemptId: attemptId || createAttemptId(cryptoImpl),
      phase: 'validate',
      origin,
      token,
      allowInsecureHttp: Boolean(allowInsecureHttp),
      permissionWasPresent: Boolean(permissionWasPresent),
      createdAt: now(),
    };

    try {
      await originApi.callWebExtension(
        chromeApi.storage.local.set,
        chromeApi.storage.local,
        [{ [PENDING_KEY]: pending }],
        chromeApi.runtime,
      );
    } catch (error) {
      if (!permissionWasPresent) {
        try {
          await originApi.callWebExtension(
            chromeApi.permissions.remove,
            chromeApi.permissions,
            [permission],
            chromeApi.runtime,
          );
        } catch (rollbackError) {
          // durable 상태를 기록할 수 없으므로 저장 실패만 보고한다.
        }
      }
      throw originApi.codeError('pending_storage_failed');
    }

    const response = await originApi.callWebExtension(
      chromeApi.runtime.sendMessage,
      chromeApi.runtime,
      [{ type: 'pinry:validate-pending-server' }],
      chromeApi.runtime,
    );
    if (!response || response.ok !== true) {
      throw originApi.codeError(safeResponseCode(response));
    }
    return response;
  }

  function initializeOptions(scope) {
    const { document, chrome } = scope;
    const form = document.getElementById('serverForm');
    const originInput = document.getElementById('pinryUrl');
    const originError = document.getElementById('pinryUrlError');
    const tokenInput = document.getElementById('pinryToken');
    const tokenError = document.getElementById('pinryTokenError');
    const insecureConsent = document.getElementById('allowInsecureHttp');
    const contextMenu = document.getElementById('contextMenu');
    const submitButton = document.getElementById('saveServerSettings');
    const deleteButton = document.getElementById('deleteCredentials');
    const deleteConfirmation = document.getElementById('deleteCredentialsConfirmation');
    const deleteQuestion = document.getElementById('deleteCredentialsQuestion');
    const confirmDeleteButton = document.getElementById('confirmDeleteCredentials');
    const cancelDeleteButton = document.getElementById('cancelDeleteCredentials');
    const revalidateButton = document.getElementById('revalidateServer');
    const status = document.getElementById('status');
    const stateElements = {
      serverState: document.getElementById('serverState'),
      serverConnectionStatus: document.getElementById('serverConnectionStatus'),
      serverOrigin: document.getElementById('serverOrigin'),
      serverUsername: document.getElementById('serverUsername'),
      serverPermission: document.getElementById('serverPermission'),
      serverTokenState: document.getElementById('serverTokenState'),
    };
    let viewState = {
      phase: 'loading',
      configured: false,
      origin: null,
      username: null,
      hasPermission: false,
    };
    let originDirty = false;
    let tokenDirty = false;
    let stateVersion = 0;
    let operationInFlight = false;
    let deleteConfirmationVisible = false;

    tokenInput.value = '';
    originInput.value = '';
    deleteConfirmation.hidden = true;
    deleteButton.setAttribute('aria-expanded', 'false');
    renderServerState(stateElements, viewState);

    function updateControls() {
      const controlsLocked = operationInFlight || deleteConfirmationVisible;
      updateSaveEligibility(originInput, tokenInput, submitButton);
      if (controlsLocked) submitButton.disabled = true;
      revalidateButton.disabled = controlsLocked || viewState.phase === 'loading';
      deleteButton.disabled = controlsLocked
        || viewState.phase !== 'ready'
        || !viewState.configured;
      confirmDeleteButton.disabled = operationInFlight || !deleteConfirmationVisible;
      cancelDeleteButton.disabled = operationInFlight || !deleteConfirmationVisible;
      originInput.disabled = controlsLocked;
      tokenInput.disabled = controlsLocked;
      insecureConsent.disabled = controlsLocked;
    }

    function setOperationInFlight(value) {
      operationInFlight = value;
      updateControls();
    }

    function hideDeleteConfirmation(restoreFocus = false) {
      deleteConfirmationVisible = false;
      deleteConfirmation.hidden = true;
      deleteQuestion.textContent = '';
      deleteButton.setAttribute('aria-expanded', 'false');
      updateControls();
      if (restoreFocus && !deleteButton.disabled) deleteButton.focus();
    }

    function showDeleteConfirmation() {
      if (operationInFlight
        || deleteConfirmationVisible
        || viewState.phase !== 'ready'
        || !viewState.configured) return;
      const savedOrigin = viewState.origin;
      deleteQuestion.textContent = savedOrigin
        ? `${savedOrigin} 연결과 저장된 인증 정보를 삭제하시겠습니까?`
        : '저장된 연결과 인증 정보를 삭제하시겠습니까?';
      deleteConfirmationVisible = true;
      deleteConfirmation.hidden = false;
      deleteButton.setAttribute('aria-expanded', 'true');
      updateControls();
      confirmDeleteButton.focus();
    }

    updateControls();

    function setStatus(code) {
      status.textContent = Object.hasOwn(STATUS_MESSAGES, code)
        ? STATUS_MESSAGES[code] : STATUS_MESSAGES.server_validation_failed;
    }

    function setFieldError(input, errorElement, message) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', errorElement.id);
      errorElement.textContent = message;
    }

    function clearFieldError(input, errorElement) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
      errorElement.textContent = '';
    }

    function showReady(state) {
      viewState = { phase: 'ready', ...state };
      renderServerState(stateElements, viewState);
      updateControls();
      return viewState;
    }

    function hydrateForm(state, force = false) {
      if (force || !originDirty) originInput.value = state.configured ? state.origin : '';
      if (force || !tokenDirty) tokenInput.value = '';
      if (force) {
        originDirty = false;
        tokenDirty = false;
      }
      updateControls();
    }

    function showUnavailable(error) {
      viewState = { ...viewState, phase: 'unavailable' };
      renderServerState(stateElements, viewState);
      updateControls();
      setStatus(originApi.errorCode(error));
      return viewState;
    }

    originApi.callWebExtension(
      chrome.storage.local.get,
      chrome.storage.local,
      [['contextMenu']],
      chrome.runtime,
    ).then((stored) => {
      contextMenu.checked = !stored || stored.contextMenu !== false;
    }, () => {
      contextMenu.checked = true;
    });

    const initialStateVersion = stateVersion;
    const ready = getServerState(chrome).then((state) => {
      if (initialStateVersion !== stateVersion) return viewState;
      showReady(state);
      hydrateForm(state);
      return viewState;
    }, (error) => (initialStateVersion === stateVersion
      ? showUnavailable(error) : viewState));

    originInput.addEventListener('input', () => {
      originDirty = true;
      clearFieldError(originInput, originError);
      updateControls();
    });

    tokenInput.addEventListener('input', () => {
      tokenDirty = true;
      clearFieldError(tokenInput, tokenError);
      updateControls();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (operationInFlight || deleteConfirmationVisible) return;
      clearFieldError(originInput, originError);
      clearFieldError(tokenInput, tokenError);
      const hasOrigin = originInput.value.trim() !== '';
      const hasToken = tokenInput.value !== '';
      if (!hasOrigin) {
        setFieldError(originInput, originError, STATUS_MESSAGES.invalid_server_origin);
      }
      if (!hasToken) {
        setFieldError(tokenInput, tokenError, STATUS_MESSAGES.invalid_token);
      }
      if (!hasOrigin || !hasToken) {
        setStatus(hasOrigin ? 'invalid_token' : 'invalid_server_origin');
        updateControls();
        return;
      }
      setOperationInFlight(true);
      try {
        try {
          await saveServerSettings({
            chromeApi: chrome,
            originInput: originInput.value,
            token: tokenInput.value,
            allowInsecureHttp: insecureConsent.checked,
          });
        } catch (error) {
          const code = originApi.errorCode(error);
          if (code === 'invalid_server_origin') {
            setFieldError(originInput, originError, STATUS_MESSAGES.invalid_server_origin);
          } else if (code === 'invalid_token') {
            setFieldError(tokenInput, tokenError, STATUS_MESSAGES.invalid_token);
          }
          const failedSaveStateVersion = ++stateVersion;
          try {
            const state = await getServerState(chrome);
            if (failedSaveStateVersion !== stateVersion) return;
            showReady(state);
            setStatus(code);
          } catch (stateError) {
            if (failedSaveStateVersion === stateVersion) showUnavailable(error);
          }
          return;
        }

        const saveStateVersion = ++stateVersion;
        tokenInput.value = '';
        tokenDirty = false;
        updateControls();
        try {
          const state = await getServerState(chrome);
          if (saveStateVersion !== stateVersion) return;
          showReady(state);
          hydrateForm(state, true);
          setStatus('saved');
        } catch (error) {
          if (saveStateVersion === stateVersion) showUnavailable(error);
        }
      } finally {
        setOperationInFlight(false);
      }
    });

    revalidateButton.addEventListener('click', async () => {
      if (operationInFlight || deleteConfirmationVisible || viewState.phase === 'loading') return;
      const revalidateStateVersion = ++stateVersion;
      setOperationInFlight(true);
      try {
        const state = await revalidateServer(chrome);
        if (revalidateStateVersion !== stateVersion) return;
        showReady(state);
        setStatus('revalidated');
      } catch (error) {
        if (revalidateStateVersion === stateVersion) showUnavailable(error);
      } finally {
        setOperationInFlight(false);
      }
    });

    deleteButton.addEventListener('click', showDeleteConfirmation);

    cancelDeleteButton.addEventListener('click', () => {
      if (operationInFlight || !deleteConfirmationVisible) return;
      hideDeleteConfirmation(true);
    });

    confirmDeleteButton.addEventListener('click', async () => {
      if (operationInFlight
        || !deleteConfirmationVisible
        || viewState.phase !== 'ready'
        || !viewState.configured) return;
      setStatus('deleting');
      status.focus();
      const removeStateVersion = ++stateVersion;
      setOperationInFlight(true);
      hideDeleteConfirmation();
      try {
        const response = await originApi.callWebExtension(
          chrome.runtime.sendMessage,
          chrome.runtime,
          [{ type: 'pinry:remove-server' }],
          chrome.runtime,
        );
        if (!response || response.ok !== true) throw originApi.codeError(safeResponseCode(response));
        if (removeStateVersion !== stateVersion) return;
        showReady({
          configured: false,
          origin: null,
          username: null,
          hasPermission: false,
        });
        hydrateForm(viewState, true);
        setStatus('deleted');
      } catch (error) {
        if (removeStateVersion === stateVersion) showUnavailable(error);
      } finally {
        setOperationInFlight(false);
      }
    });

    contextMenu.addEventListener('change', () => {
      originApi.callWebExtension(
        chrome.storage.local.set,
        chrome.storage.local,
        [{ contextMenu: contextMenu.checked }],
        chrome.runtime,
      ).catch(() => {});
    });

    return {
      ready,
      getViewState() { return { ...viewState }; },
    };
  }

  return {
    createAttemptId,
    getServerState,
    initializeOptions,
    renderServerState,
    revalidateServer,
    saveServerSettings,
    updateSaveEligibility,
  };
}));
