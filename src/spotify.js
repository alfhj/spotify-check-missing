const API_BASE = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_DURATION_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_WAIT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));

const timeoutError = () =>
  new SpotifyError('Spotify took too long to respond. Check your connection and try again.', {
    status: 504,
  });

function rateLimitError(waitMs) {
  const seconds = Math.max(1, Math.ceil(Number(waitMs) / 1000));
  let wait;

  if (seconds >= 3600) {
    const hours = Math.ceil(seconds / 3600);
    wait = `${hours} hour${hours === 1 ? '' : 's'}`;
  } else if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    wait = `${minutes} minute${minutes === 1 ? '' : 's'}`;
  } else {
    wait = `${seconds} second${seconds === 1 ? '' : 's'}`;
  }

  return new SpotifyError(`Spotify is rate limiting this app. Try again in ${wait}.`, {
    status: 429,
    retryAfter: seconds,
  });
}

function isTimeout(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

/** Small exponential backoff (with jitter) in milliseconds. */
function backoff(attempt) {
  return Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 300);
}

export class SpotifyError extends Error {
  constructor(message, { status = 0, body = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

/**
 * Thin Spotify Web API client for a single login session.
 *
 * - Automatically refreshes the access token.
 * - Retries rate limits (429) and transient server errors.
 * - Serializes concurrent refreshes so concurrent requests don't race.
 */
export class SpotifyClient {
  constructor(
    session,
    {
      fetchImpl = globalThis.fetch,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxDurationMs = DEFAULT_MAX_DURATION_MS,
      maxRetries = DEFAULT_MAX_RETRIES,
      maxRetryWaitMs = DEFAULT_MAX_RETRY_WAIT_MS,
    } = {}
  ) {
    this.session = session;
    this.fetchImpl = fetchImpl;
    this.refreshPromise = null;
    this.rateLimitUntil = 0;
    this.options = { timeoutMs, maxDurationMs, maxRetries, maxRetryWaitMs };
  }

  async getAccessToken() {
    const tokens = this.session.tokens;
    if (!tokens?.access_token) return this.refreshAccessToken();
    if (Date.now() >= (tokens.expires_at ?? 0) - 60_000) {
      return this.refreshAccessToken();
    }
    return tokens.access_token;
  }

  async refreshAccessToken() {
    if (!this.refreshPromise) {
      this.refreshPromise = this.#refresh().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async #refresh() {
    const { tokens } = this.session;
    if (!tokens?.refresh_token) {
      throw new SpotifyError('Your Spotify session has expired. Please log in again.', {
        status: 401,
      });
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: this.session.clientId,
    });

    let response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(Math.max(1, Number(this.options.timeoutMs) || DEFAULT_TIMEOUT_MS)),
      });
    } catch (error) {
      if (isTimeout(error)) throw timeoutError();
      throw new SpotifyError('Could not reach Spotify to refresh your login. Try again.', {
        status: 0,
      });
    }

    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.access_token) {
      const details =
        data?.error_description ||
        data?.error ||
        'Your Spotify login has expired. Please log in again.';
      const authFailure = response.status < 500;
      throw new SpotifyError(
        authFailure ? `${details} Log in again to continue.` : details,
        { status: authFailure ? 401 : response.status, body: data }
      );
    }

    tokens.access_token = data.access_token;
    tokens.expires_at = Date.now() + (data.expires_in ?? 3600) * 1000;
    if (data.refresh_token) tokens.refresh_token = data.refresh_token;
    return tokens.access_token;
  }

  /**
   * GET a Spotify API path (e.g. "/me/tracks?limit=50") or a full URL
   * (e.g. the `next` URL from a paging object).
   */
  async get(pathOrUrl, options = {}) {
    return this.request(pathOrUrl, options);
  }

  async put(pathOrUrl, options = {}) {
    return this.request(pathOrUrl, { ...options, method: 'PUT' });
  }

  async delete(pathOrUrl, options = {}) {
    return this.request(pathOrUrl, { ...options, method: 'DELETE' });
  }

  async request(
    pathOrUrl,
    {
      method = 'GET',
      body,
      timeoutMs = this.options.timeoutMs,
      maxDurationMs = this.options.maxDurationMs,
      maxRetries = this.options.maxRetries,
      maxRetryWaitMs = this.options.maxRetryWaitMs,
    } = {}
  ) {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
    const deadline = Date.now() + Math.max(1, Number(maxDurationMs) || DEFAULT_MAX_DURATION_MS);
    const attemptTimeout = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    const retryLimit = Number.isFinite(maxRetries) ? Math.max(0, maxRetries) : DEFAULT_MAX_RETRIES;
    const retryWaitLimit = Math.max(
      1,
      Number(maxRetryWaitMs) || DEFAULT_MAX_RETRY_WAIT_MS
    );
    let retries = 0;
    let refreshedFor401 = false;

    const headers = { Authorization: '', Accept: 'application/json' };
    let payload = body;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string' || body instanceof URLSearchParams) {
        payload = body;
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }

    for (;;) {
      if (Date.now() >= deadline) throw timeoutError();

      // Another concurrent request may have learned about a rate limit. Wait
      // for the shared cooldown instead of hitting Spotify again immediately.
      const cooldown = this.rateLimitUntil - Date.now();
      if (cooldown > 0) {
        if (cooldown >= deadline - Date.now()) throw rateLimitError(cooldown);
        await sleep(cooldown);
        continue;
      }

      const token = await this.getAccessToken();
      if (Date.now() >= deadline) throw timeoutError();
      headers.Authorization = `Bearer ${token}`;

      let response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(attemptTimeout, deadline - Date.now()))
          ),
        });
      } catch (error) {
        // A timed-out attempt will not become faster if retried; fail promptly.
        if (isTimeout(error) || Date.now() >= deadline) throw timeoutError();
        if (retries++ < retryLimit) {
          await sleep(Math.min(backoff(retries), Math.max(1, deadline - Date.now())));
          continue;
        }
        throw new SpotifyError('Could not reach Spotify. Check your connection and try again.', {
          status: 0,
        });
      }

      if (response.status === 401 && !refreshedFor401) {
        refreshedFor401 = true;
        await this.refreshAccessToken();
        continue;
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const requestedWait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : backoff(retries + 1) + 1000;
        const remaining = deadline - Date.now();
        const wait = Math.min(requestedWait, retryWaitLimit);

        // Tell concurrent requests (and later requests) not to hammer Spotify.
        this.rateLimitUntil = Math.max(this.rateLimitUntil, Date.now() + wait);

        if (retries++ >= retryLimit || wait >= remaining) {
          throw rateLimitError(requestedWait);
        }

        await sleep(wait);
        continue;
      }

      if (response.status >= 500) {
        if (retries++ >= retryLimit) {
          throw new SpotifyError(
            `Spotify had a temporary problem (HTTP ${response.status}). Try again shortly.`,
            { status: response.status }
          );
        }
        const remaining = deadline - Date.now();
        const wait = Math.min(backoff(retries), retryWaitLimit);
        if (wait >= remaining) {
          throw new SpotifyError(
            `Spotify had a temporary problem (HTTP ${response.status}). Try again shortly.`,
            { status: response.status }
          );
        }
        await sleep(wait);
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null);
        throw new SpotifyError(
          errorBody?.error?.message || errorBody?.error_description || `Spotify request failed (HTTP ${response.status}).`,
          { status: response.status, body: errorBody }
        );
      }

      if (response.status === 204) return null;
      let text;
      try {
        text = await response.text();
      } catch (error) {
        if (isTimeout(error) || Date.now() >= deadline) throw timeoutError();
        throw new SpotifyError('Could not read the response from Spotify. Try again.', {
          status: 0,
        });
      }
      if (!text) return null;
      return JSON.parse(text);
    }
  }
}
