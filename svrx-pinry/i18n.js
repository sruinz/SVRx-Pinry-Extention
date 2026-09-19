(function exposeI18n(root, factory) {
  const messages = typeof module === 'object' && module.exports
    ? require('./translations.js') : root.PinryTranslations;
  const api = factory(messages, root.navigator?.language);
  root.PinryI18n = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(globalThis, function buildI18n(messages, browserLanguage) {
  'use strict';
  const listeners = new Set();
  const bindings = new WeakMap();
  const messageValues = new WeakSet();
  let locale = normalizeLocale(browserLanguage);

  function normalizeLocale(value) {
    const language = typeof value === 'string' ? value.toLowerCase().split(/[-_]/)[0] : '';
    return ['ko', 'en', 'zh', 'fr'].includes(language) ? language : 'en';
  }

  function t(key, values = {}) {
    const text = Object.hasOwn(messages[locale], key) ? messages[locale][key]
      : Object.hasOwn(messages.en, key) ? messages.en[key] : key;
    return text.replace(/\{(\w+)\}/g, (placeholder, name) => (
      Object.hasOwn(values, name) ? String(values[name]) : placeholder
    ));
  }

  function message(key, values = {}) {
    const result = Object.freeze({ key, values: { ...values }, toString() { return t(key, this.values); } });
    messageValues.add(result);
    return result;
  }

  function setLocale(value) {
    const next = normalizeLocale(value);
    if (locale === next) return;
    locale = next;
    listeners.forEach((listener) => listener(locale));
  }

  function bind(element, property, value) {
    let records = bindings.get(element);
    if (!records) { records = new Map(); bindings.set(element, records); }
    if (value && typeof value === 'object' && messageValues.has(value)) records.set(property, value);
    else records.delete(property);
    if (property === 'textContent') element.textContent = String(value);
    else element.setAttribute(property, String(value));
  }

  function setText(element, value) { bind(element, 'textContent', value); }
  function setAttribute(element, name, value) { bind(element, name, value); }

  function refresh(element) {
    const records = bindings.get(element);
    if (records) records.forEach((value, property) => bind(element, property, value));
    for (const child of element.children || []) refresh(child);
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function watch(element) { return subscribe(() => refresh(element)); }

  return { normalizeLocale, t, message, setLocale, setText, setAttribute, watch, subscribe, getLocale: () => locale };
}));
