(function exposeOrigin(root, factory) {
  const api = factory(root);
  root.PinryOrigin = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(globalThis, function buildOriginApi(root) {
  'use strict';

  function codeError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function errorCode(error, fallback = 'unexpected_error') {
    if (error && typeof error.code === 'string') return error.code;
    return fallback;
  }

  function normalizeServerOrigin(input) {
    if (typeof input !== 'string') throw codeError('invalid_server_origin');
    if (/[\u0000-\u001f\u007f]/.test(input) || input.includes('\\')) {
      throw codeError('invalid_server_origin');
    }
    const trimmed = input.trim();
    if (!trimmed) throw codeError('invalid_server_origin');
    const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed);
    const rawUrl = hasScheme ? trimmed : `https://${trimmed}`;
    const rawMatch = /^(https?):\/\/([^/?#]*)(.*)$/i.exec(rawUrl);
    if (!rawMatch) throw codeError('invalid_server_origin');
    const authority = rawMatch[2];
    const tail = rawMatch[3];
    if (!authority || authority.includes('@') || (tail !== '' && tail !== '/')) {
      throw codeError('invalid_server_origin');
    }

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (error) {
      throw codeError('invalid_server_origin');
    }
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
      || parsed.origin === 'null'
    ) {
      throw codeError('invalid_server_origin');
    }
    return parsed.origin;
  }

  function permissionPattern(origin) {
    return `${normalizeServerOrigin(origin)}/*`;
  }

  async function validateToken(origin, token, fetchImpl) {
    const normalizedOrigin = normalizeServerOrigin(origin);
    if (typeof token !== 'string' || token === '') {
      throw codeError('invalid_token');
    }
    const endpoint = `${normalizedOrigin}/api/v2/profile/users/`;
    const request = fetchImpl || root.fetch.bind(root);
    let response;
    try {
      response = await request(endpoint, {
        method: 'GET',
        headers: { Authorization: `Token ${token}` },
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (error) {
      throw codeError('profile_request_failed');
    }
    if (!response || !response.ok || response.status < 200 || response.status >= 300) {
      throw codeError('profile_request_failed');
    }
    if (response.redirected) throw codeError('profile_redirected');
    if (response.url) {
      let responseOrigin;
      try {
        responseOrigin = new URL(response.url).origin;
      } catch (error) {
        throw codeError('profile_invalid_response');
      }
      if (responseOrigin !== normalizedOrigin) {
        throw codeError('profile_origin_mismatch');
      }
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw codeError('profile_invalid_response');
    }
    if (!Array.isArray(body) || body.length !== 1) {
      throw codeError('profile_invalid_response');
    }
    const profile = body[0];
    if (!profile || profile.token !== token) throw codeError('token_mismatch');
    if (typeof profile.username !== 'string' || profile.username === '') {
      throw codeError('profile_invalid_response');
    }
    return { username: profile.username };
  }

  function callWebExtension(method, receiver, args = [], runtime) {
    return new Promise((resolve, reject) => {
      let settled = false;
      function succeed(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      function fail() {
        if (settled) return;
        settled = true;
        reject(codeError('webextension_api_error'));
      }
      function callback(value) {
        let lastError;
        try {
          lastError = runtime && runtime.lastError;
        } catch (error) {
          fail();
          return;
        }
        if (lastError) fail();
        else succeed(value);
      }

      let returned;
      try {
        returned = method.apply(receiver, [...args, callback]);
      } catch (error) {
        fail();
        return;
      }
      if (returned && typeof returned.then === 'function') {
        returned.then(succeed, fail);
      }
    });
  }

  function isOptionsPage(sender, runtime) {
    return Boolean(
      sender
      && sender.id === runtime.id
      && sender.url === runtime.getURL('options.html'),
    );
  }

  function isCurrentExtensionTopFrame(sender, runtime) {
    return Boolean(
      sender
      && sender.id === runtime.id
      && sender.tab
      && Number.isInteger(sender.tab.id)
      && sender.frameId === 0,
    );
  }

  function inspectDataProperties(value, requiredKeys, optionalKeys = []) {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const inspected = {};
      for (const key of requiredKeys) {
        const descriptor = descriptors[key];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
        inspected[key] = descriptor.value;
      }
      for (const key of optionalKeys) {
        const descriptor = descriptors[key];
        if (descriptor && !Object.hasOwn(descriptor, 'value')) return null;
        inspected[key] = descriptor ? descriptor.value : undefined;
      }
      return inspected;
    } catch (_error) {
      return null;
    }
  }

  function extensionOrigin(url) {
    return `${url.protocol}//${url.host}`;
  }

  function inspectOverlayLauncherSender(sender, runtime) {
    const inspected = inspectDataProperties(
      sender,
      ['id', 'tab', 'frameId', 'url'],
      ['origin'],
    );
    if (!inspected || inspected.id !== runtime.id || inspected.frameId !== 0
      || typeof inspected.url !== 'string') return null;
    const tab = inspectDataProperties(inspected.tab, ['id'], ['url']);
    if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0) return null;

    let actual;
    try {
      actual = new URL(inspected.url);
    } catch (_error) {
      return null;
    }
    if ((actual.protocol !== 'http:' && actual.protocol !== 'https:')
      || actual.origin === 'null' || actual.username !== '' || actual.password !== ''
      || actual.href !== inspected.url
      || (tab.url !== undefined && tab.url !== inspected.url)
      || (inspected.origin !== undefined && inspected.origin !== actual.origin)) return null;
    return Object.freeze({ tabId: tab.id, url: actual.href });
  }

  function inspectOverlayFrameSender(sender, runtime) {
    const inspected = inspectDataProperties(
      sender,
      ['id', 'tab', 'frameId', 'url'],
      ['documentId', 'origin'],
    );
    if (!inspected || inspected.id !== runtime.id || typeof inspected.url !== 'string'
      || !Number.isSafeInteger(inspected.frameId) || inspected.frameId <= 0) return null;
    const tab = inspectDataProperties(inspected.tab, ['id']);
    if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 0) return null;

    let actual;
    let expected;
    try {
      actual = new URL(inspected.url);
      expected = new URL('overlay.html', runtime.getURL(''));
    } catch (_error) {
      return null;
    }
    if (actual.protocol !== expected.protocol || actual.host !== expected.host
      || actual.username !== '' || actual.password !== ''
      || actual.pathname !== expected.pathname || actual.search !== ''
      || actual.href !== inspected.url
      || (actual.hash !== '' && !/^#[0-9a-f]{64}$/.test(actual.hash))
      || (inspected.origin !== undefined
        && inspected.origin !== extensionOrigin(expected))) return null;
    const documentId = inspected.documentId === undefined ? null : inspected.documentId;
    if (documentId !== null && (typeof documentId !== 'string' || documentId === '')) return null;
    return Object.freeze({
      tabId: tab.id,
      frameId: inspected.frameId,
      documentId,
      url: actual.href,
      hash: actual.hash,
    });
  }

  function isAllowedSender(messageType, sender, runtime, job) {
    if (messageType === 'pinry:validate-pending-server'
      || messageType === 'pinry:remove-server') {
      return isOptionsPage(sender, runtime);
    }
    if (messageType === 'pinry:get-server-state') {
      return isOptionsPage(sender, runtime)
        || isCurrentExtensionTopFrame(sender, runtime);
    }
    if (messageType === 'pinry:revalidate-server') {
      return isOptionsPage(sender, runtime);
    }
    if (messageType === 'pinry:create-job'
      || messageType === 'pinry:create-board'
      || messageType === 'pinry:open-options') {
      return isCurrentExtensionTopFrame(sender, runtime);
    }
    if (messageType === 'pinry:get-job'
      || messageType === 'pinry:retry-job'
      || messageType === 'pinry:discard-job') {
      return isCurrentExtensionTopFrame(sender, runtime)
        && job
        && sender.tab.id === job.source_tab_id;
    }
    return false;
  }

  return {
    callWebExtension,
    codeError,
    errorCode,
    inspectOverlayFrameSender,
    inspectOverlayLauncherSender,
    isAllowedSender,
    normalizeServerOrigin,
    permissionPattern,
    validateToken,
  };
}));
