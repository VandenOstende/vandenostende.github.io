// ============================================================
// solver.worker.js — runs the parking solve off the main thread.
// The app posts {reqId, site, obstacles, params, orientationIndex};
// this posts back {reqId, result} (or {reqId, error}). A dead/absent
// worker is handled by an inline fallback in app.js.
// ============================================================
import { solveParking } from './solver.js?v=adb69ce8';

self.onmessage = (e) => {
  const { reqId, site, obstacles, params, orientationIndex } = e.data || {};
  try {
    const result = solveParking(site, obstacles, params, orientationIndex);
    self.postMessage({ reqId, result });
  } catch (err) {
    self.postMessage({ reqId, error: String((err && err.message) || err) });
  }
};
