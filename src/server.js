import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadEnv } from './env.js';
import { analyzeLibrary } from './analysis.js';
import { changeSavedItems, hasWriteScope } from './library.js';
import { SpotifyClient } from './spotify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnv(path.join(__dirname, '..', '.env'));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 8888);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const REDIRECT_URI = process.env.REDIRECT_URI || `${PUBLIC_URL}/auth/callback`;
const SCOPES = 'user-library-read user-read-private';
const WRITE_SCOPES = `${SCOPES} user-library-modify`;
const ENV_CLIENT_ID = (process.env.SPOTIFY_CLIENT_ID || '').trim();
const SESSION_COOKIE = 'sld_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** @type {Map<string, {clientId: string, tokens: object, profile: object|null, cached: object|null, createdAt: number, lastSeen: number}>} */
const sessions = new Map();
/** @type {Map<string, {verifier: string, clientId: string, redirectUri: string, write: boolean, createdAt: number}>} */
const oauthStates = new Map();

const isValidClientId = (value) => /^[0-9a-f]{32}$/i.test(value || '');
const configuredClientId = isValidClientId(ENV_CLIENT_ID) ? ENV_CLIENT_ID : null;

if (ENV_CLIENT_ID && !configuredClientId) {
  console.warn('SPOTIFY_CLIENT_ID is set but does not look like a Spotify client ID (32 hex characters).');
}

const app = express();
app.disable('x-powered-by');

const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('base64url');
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function getSession(req) {
  const sid = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  session.lastSeen = Date.now();
  return { sid, session };
}

function safeRedirectError(res, message) {
  res.redirect(`/?error=${encodeURIComponent(message)}`);
}

function profileFromMe(me) {
  const images = Array.isArray(me?.images) ? me.images : [];
  const sorted = [...images].sort((a, b) => (a?.width ?? 0) - (b?.width ?? 0));
  const image = (sorted.find((item) => (item?.width ?? 0) >= 160) ?? sorted.at(-1))?.url ?? null;

  return {
    id: me?.id ?? null,
    displayName: me?.display_name || me?.id || 'Spotify user',
    image,
    url:
      me?.external_urls?.spotify ??
      (me?.id ? `https://open.spotify.com/user/${me.id}` : null),
    product: me?.product ?? null,
  };
}

async function exchangeCode({ code, verifier, clientId, redirectUri }) {
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    throw new Error(
      data?.error_description || data?.error || 'Spotify did not accept the login.'
    );
  }
  return data;
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

app.get('/api/config', (req, res) => {
  res.json({
    configured: Boolean(configuredClientId),
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    writeScopes: WRITE_SCOPES,
    node: process.version,
  });
});

app.get('/auth/login', (req, res) => {
  const requested = typeof req.query.client_id === 'string' ? req.query.client_id.trim() : '';
  const clientId = configuredClientId || requested;
  const write = req.query.write === '1';

  if (!isValidClientId(clientId)) {
    safeRedirectError(
      res,
      'Enter a valid Spotify Client ID (32 characters) or set SPOTIFY_CLIENT_ID in .env.'
    );
    return;
  }

  const verifier = randomToken(64);
  const state = randomToken(24);

  oauthStates.set(state, {
    verifier,
    clientId,
    redirectUri: REDIRECT_URI,
    write,
    createdAt: Date.now(),
  });

  const authorizeUrl = new URL('https://accounts.spotify.com/authorize');
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    state,
    scope: write ? WRITE_SCOPES : SCOPES,
    code_challenge_method: 'S256',
    code_challenge: sha256(verifier),
  }).toString();

  res.redirect(authorizeUrl.toString());
});

app.get(
  '/auth/callback',
  asyncRoute(async (req, res) => {
    if (typeof req.query.error === 'string') {
      const description =
        typeof req.query.error_description === 'string'
          ? req.query.error_description
          : req.query.error === 'access_denied'
            ? 'You cancelled the Spotify login.'
            : 'Spotify login failed.';
      safeRedirectError(res, description);
      return;
    }

    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const pending = oauthStates.get(state);

    if (!pending) {
      safeRedirectError(res, 'Login expired or was already used. Please try again.');
      return;
    }
    oauthStates.delete(state);

    if (!code) {
      safeRedirectError(res, 'Spotify did not return an authorization code.');
      return;
    }

    let tokens;
    try {
      tokens = await exchangeCode({
        code,
        verifier: pending.verifier,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
      });
    } catch (error) {
      safeRedirectError(res, error.message || 'Could not complete Spotify login.');
      return;
    }

    const sid = randomToken(32);
    sessions.set(sid, {
      clientId: pending.clientId,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
        scope: tokens.scope ?? (pending.write ? WRITE_SCOPES : SCOPES),
      },
      profile: null,
      cached: null,
      createdAt: Date.now(),
      lastSeen: Date.now(),
    });

    res.cookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: REDIRECT_URI.startsWith('https:'),
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
    res.redirect('/');
  })
);

app.get(
  '/api/me',
  asyncRoute(async (req, res) => {
    const found = getSession(req);
    if (!found) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    const { session } = found;

    if (!session.profile) {
      // Keep this lightweight endpoint bounded even when Spotify or the network
      // is slow. Otherwise the browser request can appear to hang for minutes.
      const client = new SpotifyClient(session, {
        timeoutMs: 10_000,
        maxDurationMs: 20_000,
        maxRetries: 1,
      });
      session.profile = profileFromMe(await client.get('/me'));
    }

    res.json({
      profile: session.profile,
      canWrite: hasWriteScope(session.tokens?.scope),
    });
  })
);

app.post('/api/logout', (req, res) => {
  const found = getSession(req);
  if (found) sessions.delete(found.sid);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

function libraryChangeHandler(kind) {
  return asyncRoute(async (req, res) => {
    const found = getSession(req);
    if (!found) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    const { session } = found;

    if (!hasWriteScope(session.tokens?.scope)) {
      res.status(403).json({
        error: 'write_scope_missing',
        message: 'Reconnect with changes enabled to modify your Spotify library.',
      });
      return;
    }

    const { ids, action } = req.body ?? {};
    const client = new SpotifyClient(session);
    const updated = await changeSavedItems(client, { kind, action, ids });

    // The cached audit is stale as soon as the library changes.
    session.cached = null;
    session.lastSeen = Date.now();

    res.json({ ok: true, kind, action, updated });
  });
}

app.post(
  '/api/library/tracks',
  express.json({ limit: '32kb' }),
  libraryChangeHandler('tracks')
);
app.post(
  '/api/library/albums',
  express.json({ limit: '32kb' }),
  libraryChangeHandler('albums')
);

app.get(
  '/api/analysis',
  asyncRoute(async (req, res) => {
    const found = getSession(req);
    if (!found) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    const { session } = found;
    const forceRefresh = req.query.refresh === '1';

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let finished = false;
    const send = (event, payload) => {
      if (finished || res.writableEnded || res.destroyed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        finished = true;
      }
    };

    if (!forceRefresh && session.cached) {
      send('done', session.cached);
      res.end();
      return;
    }

    const heartbeat = setInterval(() => {
      if (!finished && !res.writableEnded) {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          finished = true;
        }
      }
    }, 15_000);
    heartbeat.unref?.();

    try {
      const client = new SpotifyClient(session);
      const result = await analyzeLibrary(client, {
        onProgress: (update) => send('progress', update),
        profile: session.profile,
      });
      session.cached = result;
      session.profile = result.profile;
      send('done', result);
    } catch (error) {
      const status = Number.isFinite(error?.status) ? error.status : 500;
      if (status === 401) {
        // The refresh token is dead: make the browser log in again.
        sessions.delete(found.sid);
      }
      const retryAfter = Number(error?.retryAfter);
      send('failure', {
        status,
        message: error?.message || 'Something went wrong while checking your library.',
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
      });
    } finally {
      clearInterval(heartbeat);
      finished = true;
      if (!res.writableEnded) res.end();
    }
  })
);

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: 0 }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.status(404).type('text/plain').send('Not found');
});

app.use((error, req, res, next) => {
  console.error('[spotify-check-missing]', error);
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = Number.isFinite(error?.status) && error.status >= 400 ? error.status : 500;
  const retryAfter = Number(error?.retryAfter);
  const hasRetryAfter = Number.isFinite(retryAfter) && retryAfter > 0;
  if (hasRetryAfter) res.set('Retry-After', String(Math.ceil(retryAfter)));
  if (req.path.startsWith('/api/')) {
    res.status(status).json({
      error: error?.message || 'Internal server error',
      ...(hasRetryAfter ? { retryAfter } : {}),
    });
    return;
  }
  res.status(status).type('text/plain').send(status === 500 ? 'Internal server error' : error.message);
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [state, pending] of oauthStates) {
    if (now - pending.createdAt > OAUTH_STATE_TTL_MS) oauthStates.delete(state);
  }
  for (const [sid, session] of sessions) {
    if (now - session.lastSeen > SESSION_TTL_MS) sessions.delete(sid);
  }
}, 10 * 60 * 1000);
cleanupTimer.unref?.();

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Spotify Library Diff');
  console.log(`  → http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`  Redirect URI: ${REDIRECT_URI}`);
  if (!configuredClientId) {
    console.log('  No SPOTIFY_CLIENT_ID set — paste your Client ID in the browser.');
  }
  console.log('');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to a free port in .env.`);
    process.exitCode = 1;
    return;
  }
  throw error;
});
