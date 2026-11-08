export const WRITE_SCOPE = 'user-library-modify';
export const MAX_IDS_PER_REQUEST = 40;

// February 2026 replaced the per-type save/remove endpoints with one generic
// endpoint that takes Spotify URIs. Development Mode apps must use this.
const LIBRARY_ENDPOINT = '/me/library';

const URI_TYPES = {
  tracks: 'track',
  albums: 'album',
};

const METHODS = {
  save: 'PUT',
  remove: 'DELETE',
};

export class LibraryChangeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LibraryChangeError';
    this.status = 400;
  }
}

/** True when a Spotify token's granted scope allows library changes. */
export function hasWriteScope(scope = '') {
  return String(scope).split(/\s+/).includes(WRITE_SCOPE);
}

/**
 * Validate and deduplicate Spotify IDs.
 * Spotify IDs are 22-character base-62 strings.
 */
export function normalizeIds(ids) {
  if (!Array.isArray(ids)) {
    throw new LibraryChangeError('Expected a list of Spotify IDs.');
  }

  const unique = [...new Set(ids.map((id) => (typeof id === 'string' ? id.trim() : '')))];

  if (unique.length === 0 || unique.some((id) => !id)) {
    throw new LibraryChangeError('At least one Spotify ID is required.');
  }

  const invalid = unique.find((id) => !/^[0-9A-Za-z]{22}$/.test(id));
  if (invalid) {
    throw new LibraryChangeError(`Invalid Spotify ID: ${invalid}`);
  }

  return unique;
}

/**
 * Save or remove tracks/albums in the user's Spotify library.
 *
 * The generic library endpoint accepts at most 40 Spotify URIs per request, so
 * larger selections are split into sequential batches. Returns the number of
 * unique items changed.
 */
export async function changeSavedItems(
  client,
  { kind, action, ids, maxPerRequest = MAX_IDS_PER_REQUEST } = {}
) {
  const uriType = URI_TYPES[kind];
  if (!uriType) {
    throw new LibraryChangeError(`Unknown library item type: ${kind}`);
  }

  const method = METHODS[action];
  if (!method) {
    throw new LibraryChangeError(`Unknown library action: ${action}`);
  }

  const unique = normalizeIds(ids);
  const size = Math.max(1, Math.min(Number(maxPerRequest) || MAX_IDS_PER_REQUEST, MAX_IDS_PER_REQUEST));
  const uris = unique.map((id) => `spotify:${uriType}:${id}`);

  for (let index = 0; index < uris.length; index += size) {
    const batch = uris.slice(index, index + size);
    const query = new URLSearchParams({ uris: batch.join(',') });
    await client.request(`${LIBRARY_ENDPOINT}?${query.toString()}`, { method });
  }

  return unique.length;
}
