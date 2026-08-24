(function exposeSelection(root, factory) {
  const api = factory();
  root.PinrySelection = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(globalThis, function buildSelectionApi() {
  'use strict';

  function toggleSelectedId(selectedIds, id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
  }

  class SelectionModel {
    constructor(candidateIds) {
      this.candidateIds = [...new Set(candidateIds)];
      this.knownIds = new Set(this.candidateIds);
      this.selectedIds = new Set();
      this.anchorId = null;
    }

    toggle(id) {
      if (!this.knownIds.has(id)) return;
      toggleSelectedId(this.selectedIds, id);
      this.anchorId = id;
    }

    toggleWithModifiers(id, modifiers = {}) {
      if (!this.knownIds.has(id)) return this.selected();
      const normalized = modifiers && typeof modifiers === 'object'
        ? modifiers
        : {};
      if (normalized.shiftKey && this.anchorId !== null) {
        this.selectRange(this.anchorId, id, { append: true });
      } else {
        toggleSelectedId(this.selectedIds, id);
      }
      this.anchorId = id;
      return this.selected();
    }

    selectRange(anchorId, targetId, options = {}) {
      const start = this.candidateIds.indexOf(anchorId);
      const end = this.candidateIds.indexOf(targetId);
      if (start < 0 || end < 0) return this.selected();
      const normalized = options && typeof options === 'object' ? options : {};
      if (normalized.append === false) this.selectedIds.clear();
      const lower = Math.min(start, end);
      const upper = Math.max(start, end);
      this.candidateIds.slice(lower, upper + 1)
        .forEach((candidateId) => this.selectedIds.add(candidateId));
      return this.selected();
    }

    selectAll() {
      this.selectedIds = new Set(this.candidateIds);
    }

    clearAll() {
      this.selectedIds.clear();
      this.anchorId = null;
    }

    selected() {
      return this.candidateIds.filter((candidateId) => (
        this.selectedIds.has(candidateId)
      ));
    }
  }

  return { SelectionModel };
}));
