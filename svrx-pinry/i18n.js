(function exposeI18n(root, factory) {
  const api = factory(root);
  root.PinryI18n = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(globalThis, function buildI18nApi(root) {
  'use strict';

  function message(key, substitutions, fallback = '') {
    const chromeI18n = root.chrome && root.chrome.i18n;
    if (chromeI18n && typeof chromeI18n.getMessage === 'function') {
      try {
        const translated = chromeI18n.getMessage(key, substitutions);
        if (translated) return translated;
      } catch (_error) {
        // Fall back to the bundled English copy when the browser API is unavailable.
      }
    }
    if (typeof fallback === 'function') return fallback(substitutions);
    return fallback || key;
  }

  function uiLanguage() {
    const chromeI18n = root.chrome && root.chrome.i18n;
    if (chromeI18n && typeof chromeI18n.getUILanguage === 'function') {
      try {
        return chromeI18n.getUILanguage() || 'en';
      } catch (_error) {
        return 'en';
      }
    }
    return 'en';
  }

  function localizeDocument(documentObject) {
    if (!documentObject || typeof documentObject.querySelectorAll !== 'function') return;
    if (documentObject.documentElement) {
      documentObject.documentElement.lang = uiLanguage().replace('_', '-');
    }
    documentObject.querySelectorAll('[data-i18n]').forEach((element) => {
      const translated = message(element.dataset.i18n, undefined, element.textContent);
      element.textContent = translated;
    });
    documentObject.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      const translated = message(
        element.dataset.i18nPlaceholder,
        undefined,
        element.getAttribute('placeholder') || '',
      );
      element.setAttribute('placeholder', translated);
    });
    documentObject.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
      const translated = message(
        element.dataset.i18nAriaLabel,
        undefined,
        element.getAttribute('aria-label') || '',
      );
      element.setAttribute('aria-label', translated);
    });
  }

  return { localizeDocument, message, uiLanguage };
}));
