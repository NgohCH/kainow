/**
 * The notice page after a failed update (10b spec 5.7, D123). Runs in the `notice`
 * service (the updater image, no Docker socket, no database, no settings) on Kainow's
 * port while api is stopped. One fixed page, status 503, for every path and method;
 * inline CSS only, nothing loaded from anywhere, nothing read from the database.
 */
import { createServer, type Server } from 'node:http';

export const NOTICE_TEXT =
  'Kainow is unavailable after a failed update. Nothing you saved before the update started has been lost. Please contact your Administrator.';

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kainow is unavailable</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f6f7f9; color: #1d2430; }
  main { max-width: 36rem; margin: 15vh auto 0; padding: 2rem 1.5rem; background: #ffffff; border: 1px solid #d9dde3; border-radius: 8px; }
  h1 { font-size: 1.5rem; margin: 0 0 1rem; }
  p { font-size: 1.05rem; line-height: 1.55; margin: 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #14171c; color: #e6e9ee; }
    main { background: #1d2128; border-color: #343a44; }
  }
</style>
</head>
<body>
<main>
<h1>Kainow is unavailable</h1>
<p>${NOTICE_TEXT}</p>
</main>
</body>
</html>
`;

const BODY = Buffer.from(PAGE, 'utf8');

/** Starts serving the notice page on `port` (all interfaces; Compose publishes it on 127.0.0.1 only). */
export function startNoticeServer(port: number): Server {
  const server = createServer((req, res) => {
    req.resume(); // any request body is read and dropped
    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': BODY.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Retry-After': '300',
      // The web app's restart watch reloads on this mark (or an ok /health), never on a proxy's own error page.
      'X-Kainow-Notice': '1',
    });
    res.end(req.method === 'HEAD' ? undefined : BODY);
  });
  server.listen(port);
  return server;
}

if (require.main === module) {
  const server = startNoticeServer(3000);
  console.log('Notice page: serving the failed-update notice on port 3000.');
  // Node as PID 1 ignores SIGTERM unless handled: stop at once when Compose stops the service.
  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
