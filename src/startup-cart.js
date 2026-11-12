// Startup cart restoration runs alongside the product lookups. Its answer can arrive
// before, but be applied after, a newer cart state: another tab's change or a same-tab
// cart action. These helpers decide whether that startup answer may still be applied.

// Starts fn now (sync throws included); the returned promise never rejects.
const settle = fn => {
  try { return Promise.resolve(fn()).then(value => ({ value }), error => ({ error })); }
  catch (error) { return Promise.resolve({ error }); }
};

// Counts cart-state changes this page knows about, plus the persisted cart identity.
export function createCartStateTracker(readIdentity) {
  let local = 0;
  let external = 0;
  const identity = () => {
    const { id = null, revision = null } = readIdentity() || {};
    return { id, revision };
  };
  return {
    // Same-tab cart work (actions, refreshes, discount and checkout verification).
    localChange() { local += 1; },
    // Another tab changed persisted cart state (storage event).
    externalChange() { external += 1; },
    snapshot() { return { local, external, ...identity() }; },
    // expectedId: the cart id storage should hold once the read finished. A successful
    // read of an expired cart clears the stored id itself, which is not a newer state.
    compare(started, expectedId = started.id) {
      const now = this.snapshot();
      if (now.local !== started.local) return 'local';
      if (now.external !== started.external || now.revision !== started.revision || now.id !== expectedId) return 'external';
      return 'current';
    }
  };
}

const expectedIdAfter = (result, started) => 'value' in result ? (result.value?.id ?? null) : started.id;

// Starts the startup cart read immediately; call the returned function once products load.
// Resolves to:
//   { status: 'current', value } or { status: 'current', error } — apply as before;
//   { status: 'superseded' } — a same-tab action owns newer state; apply nothing;
//   { status: 'stale' } — another tab kept changing the cart; apply nothing, keep checkout blocked.
// At most one fresh read is made, and that read is guarded the same way.
export function startStartupCartRestore({ getCart, tracker, isBusy = () => false, maxRereads = 1 }) {
  let started = tracker.snapshot();
  let pending = settle(getCart);
  return async function finish() {
    let result = await pending;
    for (let rereads = 0; ; rereads += 1) {
      const state = isBusy() ? 'local' : tracker.compare(started, expectedIdAfter(result, started));
      if (state === 'current') return { status: 'current', ...result };
      if (state === 'local') return { status: 'superseded' };
      if (rereads >= maxRereads) return { status: 'stale' };
      started = tracker.snapshot();
      pending = settle(getCart);
      result = await pending;
    }
  };
}
