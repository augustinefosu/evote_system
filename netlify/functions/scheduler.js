// Netlify scheduled function: closes elections whose end time has passed.
//
// The long-lived server runs this on an interval; on serverless there is no
// process to keep alive, so Netlify invokes this on the schedule declared in
// netlify.toml ([functions."scheduler"].schedule).
process.env.APP_RUNTIME = 'function';

const { autoCloseElections } = require('../../src/server');
const supabase = require('../../src/supabase');

exports.handler = async () => {
  try {
    await autoCloseElections();
  } catch (err) {
    console.error('[scheduler] failed:', err.message);
    return { statusCode: 500, body: 'scheduler failed' };
  } finally {
    // The container is frozen after this runs; close the pool so the database
    // does not hold an idle connection until the next invocation.
    try { await supabase.shutdown(); } catch { /* best effort */ }
  }
  return { statusCode: 200, body: 'ok' };
};
