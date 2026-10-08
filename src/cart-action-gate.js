export function createCartActionGate() {
  let pending = false;
  return async action => {
    if (pending) return false;
    pending = true;
    try { await action(); return true; }
    finally { pending = false; }
  };
}
