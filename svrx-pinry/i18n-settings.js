(function exposeI18nSettings(root, factory) {
  const api = factory();
  root.PinryI18nSettings = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root.document) api.initialize(root);
}(globalThis, function buildI18nSettings() {
  'use strict';
  function initialize(scope) {
    const api = scope.PinryI18n;
    const chromeApi = scope.chrome;
    const browserLanguage = chromeApi.i18n?.getUILanguage() || scope.navigator?.language;
    let revision = 0;
    function apply(preference) {
      api.setLocale(['ko', 'en', 'zh', 'fr'].includes(preference) ? preference : browserLanguage);
      if (scope.document) {
        scope.document.documentElement.lang = api.getLocale() === 'zh' ? 'zh-CN' : api.getLocale();
        for (const element of scope.document.querySelectorAll('[data-i18n]')) {
          api.setText(element, api.message(element.getAttribute('data-i18n')));
        }
      }
    }
    apply(null);
    const changed = (changes, area) => {
      if (area !== 'local' || !Object.hasOwn(changes, 'extensionLocale')) return;
      revision += 1;
      apply(changes.extensionLocale.newValue);
    };
    chromeApi.storage.onChanged?.addListener(changed);
    const stopWatching = scope.document ? api.watch(scope.document.documentElement) : () => {};
    if (scope.document) scope.addEventListener('pagehide', (event) => {
      if (event.persisted) return;
      stopWatching();
      chromeApi.storage.onChanged?.removeListener(changed);
    }, { once: true });
    try {
      chromeApi.storage.local.get('extensionLocale', (stored) => {
        const failed = chromeApi.runtime.lastError;
        if (revision === 0) apply(failed ? null : stored?.extensionLocale);
      });
    } catch (_error) { apply(null); }
  }
  return { initialize };
}));
