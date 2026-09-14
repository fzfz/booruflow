globalThis.fetch = function issue180NetworkForbidden() {
  throw new Error('Issue #180 --version must not access the network');
};
