// ============================================================
// variants.worker.js — N solves off the main thread, streamed.
//
// A second worker beside solver.worker.js, deliberately. That one carries the
// live plan and its protocol is strictly one-in-flight-wins: the app drops any
// reply whose reqId is not the latest. Sharing it would queue the solve you are
// looking at behind a twelve-job batch — a single concentric solve on a large
// curved site measures 653 ms, so that is seconds of stale canvas, which is a
// worse fault than the frozen tab this exists to fix.
//
// Protocol
//   → { batchId, site, obstacles, metricObstacles, annotations, overrides,
//       manualStalls, jobs: [{ jobId, params, orientationIndex }] }
//   → { cancel: batchId }                      at any time
//   ← { batchId, jobId, ms, score, result }    one per job, as it finishes
//   ← { batchId, jobId, error }                per failed job
//   ← { batchId, done: true, n, cancelled }
//
// Three things about that shape:
//
//  - The site, the obstacles and the annotations are shared by every job, so
//    they are hoisted out of the job list rather than cloned twelve times.
//  - Replies stream. The first card fills in after ~10 ms instead of everything
//    landing at once after half a minute, which also makes the progress count
//    real information rather than a spinner.
//  - The score is computed HERE, by the same decorate → computeMetrics →
//    plausibility the live plan uses. The main thread does one setState per job
//    and nothing else, and a variant's numbers cannot drift from the plan's
//    because they are not computed by different code.
// ============================================================
import { solveParking, decorate, computeMetrics, plausibility } from './solver.js?v=fd27eff2';

// Above this, the geometry stays here. Twelve results of a 6800-stall plan is
// megabytes of structuredClone traffic and just as much retained memory on the
// other side; the card shows its numbers and says it has no preview.
const HEAVY_STALLS = 4000;

let cancelled = null; // batchId the main thread has given up on

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.cancel) { cancelled = msg.cancel; return; }

  const { batchId, site, obstacles, metricObstacles, annotations, overrides, manualStalls, jobs } = msg;
  if (!batchId || !Array.isArray(jobs)) return;

  let n = 0;
  for (const job of jobs) {
    if (cancelled === batchId) break;
    const t0 = Date.now();
    try {
      const res = solveParking(site, obstacles, job.params, job.orientationIndex || 0);
      const dec = decorate(res, { overrides, manualStalls, params: job.params });
      const m = computeMetrics(site, metricObstacles, dec, job.params, annotations);
      const pl = plausibility(dec, site, job.params);
      const heavy = dec.stalls.length > HEAVY_STALLS;
      self.postMessage({
        batchId, jobId: job.jobId, ms: Date.now() - t0, heavy,
        score: {
          total: m.total, physical: m.physicalStalls, areaPerStall: m.areaPerStall,
          adaRequired: m.adaRequired, adaProvided: m.adaProvided, aisleCount: m.aisleCount,
          imperviousPct: m.imperviousPct, orientationCount: m.orientationCount,
          packedRatio: pl.packedRatio, stallOverlaps: pl.stallOverlaps, plausible: pl.plausible,
        },
        // The decorated result, not the raw one: it is what the preview has to
        // draw (a raw aisle is a bare quad with no .poly and no .key) and what
        // adoption can reuse without solving the winner a second time.
        result: heavy ? null : dec,
      });
    } catch (err) {
      self.postMessage({ batchId, jobId: job.jobId, error: String((err && err.message) || err) });
    }
    n++;
    // A synchronous loop never yields, so onmessage would not run and a cancel
    // could not arrive until the whole batch was done. One turn of the event
    // loop between jobs makes the worst-case cancel latency one job.
    await new Promise((r) => setTimeout(r, 0));
  }
  self.postMessage({ batchId, done: true, n, cancelled: cancelled === batchId });
};
