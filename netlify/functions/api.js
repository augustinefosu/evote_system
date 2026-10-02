// Netlify Function entry point for the Express API.
//
// Netlify rewrites /api/* here (see netlify.toml) and this adapter translates
// the Lambda-style event/response to and from Express.
//
// APP_RUNTIME tells src/server.js it is running inside a function, so it
// exports the Express app instead of opening a port or scheduling an interval.
process.env.APP_RUNTIME = 'function';

const serverless = require('serverless-http');
const { app } = require('../../src/server');

const run = serverless(app);

const INTERNAL_PREFIX = '/.netlify/functions/api';

exports.handler = async (event, context) => {
  // Let Netlify freeze the container between requests without waiting for the
  // Postgres pool to drain; the pool is reused by the next invocation.
  if (context) context.callbackWaitsForEmptyEventLoop = false;

  // Depending on how the rewrite is applied, the function may see the original
  // "/api/..." path or the internal "/.netlify/functions/api/..." path.
  // Normalize to "/api/..." so the Express routes match either way.
  const normalize = (p) => (typeof p === 'string' && p.startsWith(INTERNAL_PREFIX)
    ? '/api' + p.slice(INTERNAL_PREFIX.length)
    : p);
  event.path = normalize(event.path);
  if (event.rawPath) event.rawPath = normalize(event.rawPath);

  return run(event, context);
};
