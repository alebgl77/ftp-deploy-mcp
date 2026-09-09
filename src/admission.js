// One bound per Node isolate, shared by all registries importing this module.
// No queue: callers retry explicitly after an admitted worker actually settles.
const CAPACITY = 64;
let admitted = 0;

export function acquireAdmission() {
  if (admitted >= CAPACITY) return null;
  admitted += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    admitted -= 1;
  };
}
