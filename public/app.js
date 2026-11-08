const $ = (id) => document.getElementById(id);

const CLIENT_ID_KEY = 'spotify-library-diff:client-id';
const WRITE_KEY = 'spotify-library-diff:write-mode';
const CACHE_KEY = 'spotify-library-diff:cache';
const CACHE_VERSION = 1;

const loginView = $('login-view');
const appView = $('app-view');
const loginForm = $('login-form');
const clientField = $('client-field');
const clientIdInput = $('client-id');
const envNote = $('env-note');
const loginError = $('login-error');
const redirectUriEl = $('redirect-uri');
const copyRedirectBtn = $('copy-redirect');

const userArea = $('user-area');
const userAvatar = $('user-avatar');
const userName = $('user-name');
const logoutBtn = $('logout-btn');

const refreshBtn = $('refresh-btn');
const appTitle = $('app-title');
const appSubtitle = $('app-subtitle');
const appError = $('app-error');
const writeToggle = $('write-mode');
const writeNote = $('write-note');

const statsEl = $('stats');
const statSongs = $('stat-songs');
const statAlbums = $('stat-albums');
const statMissing = $('stat-missing');
const statMissingSub = $('stat-missing-sub');
const statUnliked = $('stat-unliked');
const statUnlikedSub = $('stat-unliked-sub');

const progressCard = $('progress-card');
const progressTitle = $('progress-title');
const progressDetail = $('progress-detail');
const progressPercent = $('progress-percent');
const progressBar = $('progress-bar');

const resultsEl = $('results');
const perfectBanner = $('perfect-banner');
const resultsToolbar = $('results-toolbar');
const panelSongs = $('panel-songs');
const panelAlbums = $('panel-albums');
const songsList = $('songs-list');
const albumsList = $('albums-list');
const songsEmpty = $('songs-empty');
const albumsEmpty = $('albums-empty');
const tabSongsCount = $('tab-songs-count');
const tabAlbumsCount = $('tab-albums-count');
const searchInput = $('search-input');
const exportBtn = $('export-btn');
const resultFootnote = $('result-footnote');
const toastEl = $('toast');

const NUMBER_FORMAT = new Intl.NumberFormat();
const fmt = (value) => NUMBER_FORMAT.format(Number(value) || 0);

const state = {
  config: null,
  profile: null,
  result: null,
  query: '',
  activeTab: 'songs',
  expandedSongs: new Set(),
  expandedAlbums: new Set(),
  source: null,
  running: false,
  canWrite: false,
  writeMode: false,
  fromCache: false,
  changes: { tracks: new Set(), albums: new Set() },
  pending: new Set(),
};

const ICONS = {
  chevron:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  external:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  music:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 17.4V5.8l9-1.8v11.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="17.4" r="2.5" stroke="currentColor" stroke-width="1.7"/><circle cx="15.5" cy="15.6" r="2.5" stroke="currentColor" stroke-width="1.7"/></svg>',
};

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function icon(name, className) {
  const template = document.createElement('template');
  template.innerHTML = ICONS[name];
  const node = template.content.firstElementChild;
  if (className) node.setAttribute('class', className);
  return node;
}

function toast(message, duration = 2400) {
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove('visible'), duration);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to execCommand below.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/* ---------- Local result cache ---------- */

function readCachedResult(userId) {
  if (!userId) return null;

  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;

    const entry = JSON.parse(raw);
    if (
      !entry ||
      entry.version !== CACHE_VERSION ||
      entry.userId !== userId ||
      !entry.result?.stats ||
      !entry.result?.profile
    ) {
      return null;
    }

    return entry.result;
  } catch {
    // Corrupt or unavailable storage: fall back to a fresh audit.
    return null;
  }
}

function writeCachedResult(result) {
  const userId = result?.profile?.id;
  if (!userId) return;

  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        version: CACHE_VERSION,
        userId,
        savedAt: Date.now(),
        result,
      })
    );
  } catch {
    // Quota exceeded or storage disabled: caching is optional.
  }
}

function clearCachedResult() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // Storage can be unavailable in strict privacy modes.
  }
}

/* ---------- View switching ---------- */

function showLogin(message) {
  loginView.classList.remove('hidden');
  appView.classList.add('hidden');
  userArea.classList.add('hidden');
  if (message) showLoginError(message);
}

function showLoginError(message) {
  loginError.textContent = message;
  loginError.classList.remove('hidden');
}

function hideLoginError() {
  loginError.classList.add('hidden');
  loginError.textContent = '';
}

function applyProfile(profile) {
  if (!profile) return;
  state.profile = profile;
  userName.textContent = profile.displayName || 'Spotify user';
  if (profile.image) {
    userAvatar.src = profile.image;
    userAvatar.classList.remove('hidden');
  } else {
    userAvatar.removeAttribute('src');
    userAvatar.classList.add('hidden');
  }
}

function showApp(profile, canWrite = false) {
  state.canWrite = Boolean(canWrite);
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
  userArea.classList.remove('hidden');
  applyProfile(profile);

  let stored = false;
  try {
    stored = localStorage.getItem(WRITE_KEY) === '1';
  } catch {
    // localStorage can be unavailable in strict privacy modes.
  }
  state.writeMode = stored && state.canWrite;
  writeToggle.checked = state.writeMode;
  updateWriteNote();
}

const canEdit = () => state.writeMode && state.canWrite;

function updateWriteNote() {
  writeNote.classList.toggle('hidden', !state.writeMode);
}

function setWriteMode(enabled) {
  state.writeMode = Boolean(enabled && state.canWrite);
  writeToggle.checked = state.writeMode;
  try {
    localStorage.setItem(WRITE_KEY, state.writeMode ? '1' : '0');
  } catch {
    // Not fatal; the preference just won't persist.
  }
  updateWriteNote();
  if (state.result) {
    renderSummary(state.result);
    renderResults();
  }
}

function startWriteLogin() {
  const params = new URLSearchParams({ write: '1' });

  if (!state.config?.configured) {
    let clientId = clientIdInput.value.trim();
    if (!/^[0-9a-f]{32}$/i.test(clientId)) {
      try {
        clientId = localStorage.getItem(CLIENT_ID_KEY)?.trim() ?? '';
      } catch {
        clientId = '';
      }
    }
    if (/^[0-9a-f]{32}$/i.test(clientId)) params.set('client_id', clientId);
  }

  try {
    localStorage.setItem(WRITE_KEY, '1');
  } catch {
    // Continue anyway; write access still applies for this login.
  }

  window.location.assign(`/auth/login?${params.toString()}`);
}

function applyConfig(config) {
  state.config = config;
  if (config?.redirectUri) redirectUriEl.textContent = config.redirectUri;

  if (config?.configured) {
    clientField.classList.add('hidden');
    envNote.classList.remove('hidden');
  } else {
    clientField.classList.remove('hidden');
    envNote.classList.add('hidden');
    try {
      const saved = localStorage.getItem(CLIENT_ID_KEY);
      if (saved) clientIdInput.value = saved;
    } catch {
      // localStorage can be unavailable in strict privacy modes.
    }
  }
}

/* ---------- Analysis stream ---------- */

const PHASE_RANGES = {
  profile: [0, 2],
  likedSongs: [2, 40],
  likedAlbums: [40, 55],
  albumTracks: [55, 97],
  compare: [97, 100],
};

const PHASE_TITLES = {
  profile: 'Connecting to Spotify',
  likedSongs: 'Loading liked songs',
  likedAlbums: 'Loading liked albums',
  albumTracks: 'Reading liked albums',
  compare: 'Comparing libraries',
};

function computePercent(update) {
  const [start, end] = PHASE_RANGES[update.phase] ?? [0, 0];
  if (update.phase === 'compare') return 98;
  if (Number.isFinite(update.total) && update.total > 0 && Number.isFinite(update.fetched)) {
    return Math.min(end, start + (end - start) * (update.fetched / update.total));
  }
  return start;
}

function setProgress(percent, title, detail) {
  const rounded = Math.max(0, Math.min(100, Math.round(percent)));
  progressBar.style.width = `${rounded}%`;
  progressPercent.textContent = `${rounded}%`;
  if (title) progressTitle.textContent = title;
  if (detail) progressDetail.textContent = detail;
}

function closeStream() {
  if (state.source) {
    state.source.close();
    state.source = null;
  }
}

function runAnalysis(forceRefresh) {
  if (state.running) return;

  state.running = true;
  closeStream();
  hideAppError();
  refreshBtn.disabled = true;

  if (!state.result) {
    statsEl.classList.add('hidden');
    resultsEl.classList.add('hidden');
  }

  progressCard.classList.remove('hidden');
  setProgress(0, 'Connecting to Spotify', 'Starting the audit…');
  appTitle.textContent = 'Auditing your library…';
  appSubtitle.textContent = 'Loading your liked songs and albums from Spotify.';

  const stream = new EventSource(
    `/api/analysis${forceRefresh ? '?refresh=1' : ''}`
  );
  state.source = stream;

  stream.addEventListener('progress', (event) => {
    let update;
    try {
      update = JSON.parse(event.data);
    } catch {
      return;
    }
    setProgress(
      computePercent(update),
      PHASE_TITLES[update.phase] ?? 'Auditing your library',
      update.message ?? 'Working…'
    );
  });

  stream.addEventListener('done', (event) => {
    let result;
    try {
      result = JSON.parse(event.data);
    } catch {
      return;
    }
    if (state.source !== stream) return;
    closeStream();
    finishAnalysis(result);
  });

  stream.addEventListener('failure', (event) => {
    let failure = {};
    try {
      failure = JSON.parse(event.data);
    } catch {
      // Keep the generic message.
    }
    if (state.source !== stream) return;
    closeStream();
    failAnalysis(failure);
  });

  stream.onerror = () => {
    if (state.source !== stream) return;

    if (stream.readyState === EventSource.CLOSED) {
      closeStream();
      failAnalysis({
        message: 'Lost the connection to the local server. Is it still running?',
      });
      return;
    }

    // EventSource retries automatically. Probe the session so an expired login
    // surfaces as an error instead of an endless reconnect loop.
    if (!stream.probing) {
      stream.probing = true;
      fetch('/api/me', { headers: { Accept: 'application/json' } })
        .then((response) => {
          if (!response.ok && state.source === stream) {
            closeStream();
            failAnalysis({
              status: 401,
              message: 'Your Spotify login has expired. Log in again to run the audit.',
            });
          }
        })
        .catch(() => {})
        .finally(() => {
          stream.probing = false;
        });
    }
  };
}

function displayResult(result, { fromCache = false } = {}) {
  state.result = result;
  state.fromCache = fromCache;
  state.expandedSongs = new Set();
  state.expandedAlbums = new Set();
  state.query = '';
  state.changes = { tracks: new Set(), albums: new Set() };
  state.pending.clear();
  searchInput.value = '';

  applyProfile(result.profile);
  progressCard.classList.add('hidden');
  statsEl.classList.remove('hidden');
  resultsEl.classList.remove('hidden');

  renderSummary(result);
  renderResults();
}

function finishAnalysis(result) {
  state.running = false;
  refreshBtn.disabled = false;
  displayResult(result);
  writeCachedResult(result);
}

function showCachedResult(result) {
  state.running = false;
  refreshBtn.disabled = false;
  displayResult(result, { fromCache: true });
}

function failAnalysis({ message, status } = {}) {
  state.running = false;
  refreshBtn.disabled = false;
  progressCard.classList.add('hidden');
  appTitle.textContent = 'The check didn’t finish';
  appSubtitle.textContent = 'Fix the problem below, then run the audit again.';
  showAppError(message || 'Something went wrong while checking your library.', status);

  if (state.result) {
    statsEl.classList.remove('hidden');
    resultsEl.classList.remove('hidden');
    renderSummary(state.result);
    renderResults();
  }
}

function showAppError(message, status) {
  appError.replaceChildren();
  appError.append(
    h(
      'span',
      { class: 'banner-text' },
      h('strong', {}, status === 401 ? 'Spotify session expired. ' : 'Couldn’t finish the check. '),
      message
    )
  );

  if (status === 401) {
    appError.append(
      h(
        'button',
        {
          class: 'btn small secondary',
          type: 'button',
          onclick: () => window.location.reload(),
        },
        'Log in again'
      )
    );
  } else if (status === 429) {
    appError.append(
      h(
        'button',
        {
          class: 'btn small secondary',
          type: 'button',
          onclick: () => {
            hideAppError();
            runAnalysis(true);
          },
        },
        'Retry'
      )
    );
  } else {
    appError.append(
      h(
        'button',
        {
          class: 'btn small ghost',
          type: 'button',
          onclick: () => hideAppError(),
        },
        'Dismiss'
      )
    );
  }

  appError.classList.remove('hidden');
}

function hideAppError() {
  appError.classList.add('hidden');
  appError.replaceChildren();
}

/* ---------- Formatting ---------- */

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 1) return 'under a second';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatChecked(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'just now';
  if (Date.now() - date.getTime() < 60_000) return 'just now';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/* ---------- Summary ---------- */

function changeCounts() {
  const groups = state.result?.albumsWithMissingSongs ?? [];
  const unliked = state.result?.unlikedAlbumGroups ?? [];
  let trackOccurrences = 0;
  const likedIds = new Set();

  for (const group of groups) {
    for (const track of group.tracks) {
      if (state.changes.tracks.has(track.id)) {
        trackOccurrences += 1;
        likedIds.add(track.id);
      }
    }
  }

  let savedAlbums = 0;
  let songsInSavedAlbums = 0;
  for (const group of unliked) {
    if (state.changes.albums.has(group.album.id)) {
      savedAlbums += 1;
      songsInSavedAlbums += group.songs.length;
    }
  }

  return { trackOccurrences, likedIds, savedAlbums, songsInSavedAlbums };
}

function effectiveStats() {
  const base = state.result?.stats;
  if (!base) return base;

  const { trackOccurrences, likedIds, savedAlbums, songsInSavedAlbums } = changeCounts();

  return {
    ...base,
    likedSongs: base.likedSongs + likedIds.size,
    likedAlbums: base.likedAlbums + savedAlbums,
    missingSongs: Math.max(0, base.missingSongs - likedIds.size),
    missingSongInstances: Math.max(0, base.missingSongInstances - trackOccurrences),
    albumsWithMissingSongs: (state.result.albumsWithMissingSongs ?? []).filter((group) =>
      group.tracks.some((track) => !state.changes.tracks.has(track.id))
    ).length,
    unlikedAlbums: Math.max(0, base.unlikedAlbums - savedAlbums),
    likedSongsInUnlikedAlbums: Math.max(0, base.likedSongsInUnlikedAlbums - songsInSavedAlbums),
  };
}

function sessionChangeCount() {
  const { likedIds, savedAlbums } = changeCounts();
  return likedIds.size + savedAlbums;
}

function renderSummary(result) {
  const stats = effectiveStats();
  statSongs.textContent = fmt(stats.likedSongs);
  statAlbums.textContent = fmt(stats.likedAlbums);
  statMissing.textContent = fmt(stats.missingSongs);
  statUnliked.textContent = fmt(stats.unlikedAlbums);

  statMissingSub.textContent = stats.missingSongs
    ? `${fmt(stats.missingSongInstances)} track entries in ${fmt(stats.albumsWithMissingSongs)} album${stats.albumsWithMissingSongs === 1 ? '' : 's'}`
    : 'every album track is liked';

  statUnlikedSub.textContent = stats.unlikedAlbums
    ? `${fmt(stats.likedSongsInUnlikedAlbums)} liked song${stats.likedSongsInUnlikedAlbums === 1 ? '' : 's'} affected`
    : 'all albums are saved';

  const perfect = stats.missingSongs === 0 && stats.unlikedAlbums === 0;
  const changed = sessionChangeCount();
  perfectBanner.classList.toggle('hidden', !perfect || changed > 0);
  resultsToolbar.classList.toggle('hidden', perfect && changed === 0);

  if (perfect && changed === 0) {
    appTitle.textContent = 'Your library is in sync';
  } else if (perfect) {
    appTitle.textContent = 'All gaps closed';
  } else {
    const parts = [];
    if (stats.missingSongs) {
      parts.push(`${fmt(stats.missingSongs)} song${stats.missingSongs === 1 ? '' : 's'} to like`);
    }
    if (stats.unlikedAlbums) {
      parts.push(`${fmt(stats.unlikedAlbums)} album${stats.unlikedAlbums === 1 ? '' : 's'} to save`);
    }
    appTitle.textContent = parts.join(' · ');
  }

  appSubtitle.textContent =
    `Scanned ${fmt(stats.albumTracks)} album tracks across ${fmt(stats.likedAlbums)} liked albums ` +
    `in ${formatElapsed(result.durationMs)} · checked ${formatChecked(result.generatedAt)}` +
    (changed
      ? ` · ${fmt(changed)} change${changed === 1 ? '' : 's'} applied this session.`
      : state.fromCache
        ? ' · loaded from local cache.'
        : '.');

  const notes = [];
  if (stats.unavailableAlbums) {
    notes.push(
      `${fmt(stats.unavailableAlbums)} liked album${stats.unavailableAlbums === 1 ? '' : 's'} unavailable in your market`
    );
  }
  if (stats.localFilesSkipped) {
    notes.push(`${fmt(stats.localFilesSkipped)} local file${stats.localFilesSkipped === 1 ? '' : 's'} skipped`);
  }
  if (stats.unavailableSongs) {
    notes.push(`${fmt(stats.unavailableSongs)} unavailable saved item${stats.unavailableSongs === 1 ? '' : 's'} skipped`);
  }

  resultFootnote.textContent =
    'Comparison uses Spotify track IDs, so alternate versions of the same song count separately. ' +
    'Counts are unique tracks; the same track can appear in more than one liked album.' +
    (notes.length ? ` ${notes.join(' · ')}.` : '');

  tabSongsCount.textContent = fmt(stats.missingSongs);
  tabAlbumsCount.textContent = fmt(stats.unlikedAlbums);
  syncPanels();
}

/* ---------- Group rendering ---------- */

function albumArt(album) {
  const wrap = h(
    'span',
    { class: 'art' },
    h('span', { class: 'art-fallback', 'aria-hidden': 'true' }, icon('music'))
  );

  if (album.image) {
    const image = h('img', {
      src: album.image,
      alt: '',
      loading: 'lazy',
      decoding: 'async',
    });
    image.addEventListener('error', () => image.remove());
    wrap.append(image);
  }

  return wrap;
}

function trackActionButton(track) {
  const changed = state.changes.tracks.has(track.id);
  const pending = state.pending.has(`track:${track.id}`);

  return h(
    'button',
    {
      class: `btn tiny track-action ${changed ? 'done' : 'primary'}`,
      type: 'button',
      dataset: { action: changed ? 'unlike-track' : 'like-track', id: track.id },
      disabled: pending,
      title: changed ? 'Remove this song from Liked Songs' : 'Add this song to Liked Songs',
      'aria-pressed': String(changed),
    },
    pending ? '…' : changed ? 'Liked ✓' : 'Like'
  );
}

function trackRow(track, { likeable = false } = {}) {
  const number = track.trackNumber
    ? String(track.trackNumber).padStart(2, '0')
    : '–';

  return h(
    'div',
    { class: 'track-row' },
    h('span', { class: 'track-index' }, number),
    h(
      'span',
      { class: 'track-main' },
      h(
        'span',
        { class: 'track-name', title: track.name },
        track.name,
        track.explicit ? h('span', { class: 'explicit', title: 'Explicit' }, 'E') : null
      ),
      h(
        'span',
        { class: 'track-artists', title: track.artists.join(', ') },
        track.artists.join(', ') || 'Unknown artist'
      )
    ),
    h('span', { class: 'track-duration' }, formatDuration(track.durationMs)),
    h(
      'span',
      { class: 'track-actions' },
      canEdit() && likeable ? trackActionButton(track) : null,
      track.url
        ? h(
            'a',
            {
              class: 'track-link',
              href: track.url,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: 'Open in Spotify',
              'aria-label': `Open ${track.name} in Spotify`,
            },
            icon('external')
          )
        : h('span', { class: 'track-link' })
    )
  );
}

function groupElement({
  id,
  album,
  sub,
  pill,
  pillClass = '',
  tracks,
  open,
  kind,
  footerAction = null,
  likeable = false,
}) {
  const article = h('article', {
    class: `group${open ? ' open' : ''}`,
    dataset: { id: id ?? '', kind },
  });

  const head = h(
    'button',
    {
      class: 'group-head',
      type: 'button',
      'aria-expanded': String(open),
    },
    albumArt(album),
    h(
      'span',
      { class: 'group-title' },
      h('span', { class: 'group-name', title: album.name }, album.name),
      h('span', { class: 'group-sub' }, sub)
    ),
    h(
      'span',
      { class: 'group-side' },
      h('span', { class: `pill ${pillClass}` }, pill),
      icon('chevron', 'chevron')
    )
  );

  const body = h('div', { class: 'group-body' });
  for (const track of tracks) body.append(trackRow(track, { likeable }));

  const foot = h('div', { class: 'group-foot' });
  if (footerAction) foot.append(footerAction);
  if (album.url) {
    foot.append(
      h(
        'a',
        {
          class: 'album-open',
          href: album.url,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        'Open album in Spotify',
        icon('external')
      )
    );
  }
  if (foot.childElementCount) body.append(foot);

  article.append(head, body);
  return article;
}

function albumMatchesQuery(album, query) {
  return `${album.name} ${album.artists.join(' ')}`.toLowerCase().includes(query);
}

function visibleSongTracks(group, query) {
  if (!query || albumMatchesQuery(group.album, query)) return group.tracks;
  return group.tracks.filter((track) =>
    `${track.name} ${track.artists.join(' ')}`.toLowerCase().includes(query)
  );
}

function visibleAlbumSongs(group, query) {
  if (!query || albumMatchesQuery(group.album, query)) return group.songs;
  return group.songs.filter((track) =>
    `${track.name} ${track.artists.join(' ')}`.toLowerCase().includes(query)
  );
}

function albumActionButton(group) {
  const saved = state.changes.albums.has(group.album.id);
  const pending = state.pending.has(`album:${group.album.id}`);

  return h(
    'button',
    {
      class: `btn tiny ${saved ? 'done' : 'secondary'}`,
      type: 'button',
      dataset: { action: saved ? 'remove-album' : 'save-album', id: group.album.id },
      disabled: pending,
      title: saved
        ? 'Remove this album from Liked Albums'
        : 'Save this album to Liked Albums',
      'aria-pressed': String(saved),
    },
    pending ? '…' : saved ? 'Saved ✓' : 'Save album'
  );
}

function likeAllButton(group) {
  const remaining = group.tracks.filter((track) => !state.changes.tracks.has(track.id));
  if (remaining.length === 0) return null;

  const pending = state.pending.has(`bulk:${group.album.id}`);

  return h(
    'button',
    {
      class: 'btn tiny primary',
      type: 'button',
      dataset: { action: 'like-album-tracks', id: group.album.id },
      disabled: pending,
    },
    pending
      ? 'Liking…'
      : `Like all ${remaining.length} song${remaining.length === 1 ? '' : 's'}`
  );
}

function renderSongGroups(groups) {
  const query = state.query;
  songsList.replaceChildren();
  let shown = 0;

  for (const group of groups) {
    const tracks = visibleSongTracks(group, query);
    const albumHit = !query || albumMatchesQuery(group.album, query);
    if (query && !albumHit && tracks.length === 0) continue;

    shown += 1;
    const open = query ? true : state.expandedSongs.has(group.album.id);
    const remaining = group.tracks.filter(
      (track) => !state.changes.tracks.has(track.id)
    ).length;
    const sub =
      `${group.album.artists.join(', ') || 'Unknown artist'} · ` +
      `${remaining} of ${group.totalTracks} track${group.totalTracks === 1 ? '' : 's'} not liked`;

    songsList.append(
      groupElement({
        id: group.album.id,
        album: group.album,
        sub,
        pill: remaining ? `${remaining} missing` : 'all liked',
        pillClass: remaining ? '' : 'done-pill',
        tracks,
        open,
        kind: 'songs',
        likeable: true,
        footerAction: canEdit() ? likeAllButton(group) : null,
      })
    );
  }

  songsEmpty.classList.toggle('hidden', shown > 0);
}

function renderAlbumGroups(groups) {
  const query = state.query;
  albumsList.replaceChildren();
  let shown = 0;

  for (const group of groups) {
    const songs = visibleAlbumSongs(group, query);
    const albumHit = !query || albumMatchesQuery(group.album, query);
    if (query && !albumHit && songs.length === 0) continue;

    shown += 1;
    const open = query ? true : state.expandedAlbums.has(group.album.id);
    const year = group.album.releaseDate ? group.album.releaseDate.slice(0, 4) : null;
    const saved = state.changes.albums.has(group.album.id);
    const sub =
      `${group.album.artists.join(', ') || 'Unknown artist'}` +
      (year ? ` · ${year}` : '') +
      (saved ? ' · saved to Liked Albums' : ' · album not in Liked Albums');

    albumsList.append(
      groupElement({
        id: group.album.id,
        album: group.album,
        sub,
        pill: saved
          ? 'album saved'
          : `${group.songs.length} liked song${group.songs.length === 1 ? '' : 's'}`,
        pillClass: saved ? 'done-pill' : 'album-pill',
        tracks: songs,
        open,
        kind: 'albums',
        footerAction: canEdit() ? albumActionButton(group) : null,
      })
    );
  }

  albumsEmpty.classList.toggle('hidden', shown > 0);
}

function renderResults() {
  if (!state.result) return;
  renderSongGroups(state.result.albumsWithMissingSongs ?? []);
  renderAlbumGroups(state.result.unlikedAlbumGroups ?? []);
  syncPanels();
}

function selectTab(tab) {
  state.activeTab = tab;
  for (const button of document.querySelectorAll('.tab')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  syncPanels();
}

function syncPanels() {
  const stats = effectiveStats();
  const perfect = stats && stats.missingSongs === 0 && stats.unlikedAlbums === 0;
  const hidden = Boolean(perfect) && sessionChangeCount() === 0;

  panelSongs.classList.toggle('hidden', hidden || state.activeTab !== 'songs');
  panelAlbums.classList.toggle('hidden', hidden || state.activeTab !== 'albums');
}

/* ---------- Interaction handlers ---------- */

function toggleGroup(event) {
  const head = event.target.closest('.group-head');
  if (!head) return;
  const group = head.closest('.group');
  if (!group) return;

  const open = group.classList.toggle('open');
  head.setAttribute('aria-expanded', String(open));

  if (state.query) return;
  const id = group.dataset.id;
  const set = group.dataset.kind === 'albums' ? state.expandedAlbums : state.expandedSongs;
  if (open) set.add(id);
  else set.delete(id);
}

songsList.addEventListener('click', toggleGroup);
albumsList.addEventListener('click', toggleGroup);

/* ---------- Library changes ---------- */

function markPending(keys, on) {
  for (const key of keys) {
    if (on) state.pending.add(key);
    else state.pending.delete(key);
  }
}

function rerenderAfterChange() {
  if (!state.result) return;
  renderSummary(state.result);
  renderResults();
}

async function postLibraryChange(kind, action, ids) {
  const response = await fetch(`/api/library/${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ids, action }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    if (response.status === 401) {
      state.canWrite = false;
      setWriteMode(false);
      throw new Error('Your Spotify session expired. Log in again to continue.');
    }
    if (data?.error === 'write_scope_missing') {
      state.canWrite = false;
      setWriteMode(false);
      throw new Error('This login is read-only. Turn on Allow changes again to reconnect.');
    }
    throw new Error(data?.message || data?.error || 'Spotify did not accept the change.');
  }

  return data;
}

async function changeTracks(ids, action, extraPending = []) {
  const targets = [...new Set(ids)].filter((id) => !state.pending.has(`track:${id}`));
  if (targets.length === 0) return;

  const pendingKeys = [...targets.map((id) => `track:${id}`), ...extraPending];
  markPending(pendingKeys, true);
  rerenderAfterChange();

  try {
    await postLibraryChange('tracks', action, targets);
    for (const id of targets) {
      if (action === 'save') state.changes.tracks.add(id);
      else state.changes.tracks.delete(id);
    }
    clearCachedResult();
    toast(
      action === 'save'
        ? `Liked ${targets.length === 1 ? '1 song' : `${targets.length} songs`}`
        : `Removed ${targets.length === 1 ? '1 like' : `${targets.length} likes`}`
    );
  } catch (error) {
    toast(error.message, 6000);
  } finally {
    markPending(pendingKeys, false);
    rerenderAfterChange();
  }
}

async function changeAlbums(ids, action) {
  const targets = [...new Set(ids)].filter((id) => !state.pending.has(`album:${id}`));
  if (targets.length === 0) return;

  const pendingKeys = targets.map((id) => `album:${id}`);
  markPending(pendingKeys, true);
  rerenderAfterChange();

  try {
    await postLibraryChange('albums', action, targets);
    for (const id of targets) {
      if (action === 'save') state.changes.albums.add(id);
      else state.changes.albums.delete(id);
    }
    clearCachedResult();
    toast(
      action === 'save'
        ? `Saved ${targets.length === 1 ? 'album' : `${targets.length} albums`} to Liked Albums`
        : `Removed ${targets.length === 1 ? 'album' : `${targets.length} albums`} from Liked Albums`
    );
  } catch (error) {
    toast(error.message, 6000);
  } finally {
    markPending(pendingKeys, false);
    rerenderAfterChange();
  }
}

function handleLibraryAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;

  event.preventDefault();
  const { action, id } = button.dataset;

  if (action === 'like-track') {
    changeTracks([id], 'save');
  } else if (action === 'unlike-track') {
    changeTracks([id], 'remove');
  } else if (action === 'save-album') {
    changeAlbums([id], 'save');
  } else if (action === 'remove-album') {
    changeAlbums([id], 'remove');
  } else if (action === 'like-album-tracks') {
    const group = (state.result?.albumsWithMissingSongs ?? []).find(
      (item) => item.album.id === id
    );
    if (!group) return;
    const ids = group.tracks
      .filter((track) => !state.changes.tracks.has(track.id))
      .map((track) => track.id);
    changeTracks(ids, 'save', [`bulk:${id}`]);
  }
}

songsList.addEventListener('click', handleLibraryAction);
albumsList.addEventListener('click', handleLibraryAction);

writeToggle.addEventListener('change', () => {
  if (!writeToggle.checked) {
    setWriteMode(false);
    return;
  }
  if (state.canWrite) setWriteMode(true);
  else startWriteLogin();
});

for (const button of document.querySelectorAll('.tab')) {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
}

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = searchInput.value.trim().toLowerCase();
    renderResults();
  }, 140);
});

refreshBtn.addEventListener('click', () => runAnalysis(true));

exportBtn.addEventListener('click', () => {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const date = new Date(state.result.generatedAt).toISOString().slice(0, 10);
  link.href = url;
  link.download = `spotify-library-diff-${date}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Exported diff as JSON');
});

copyRedirectBtn.addEventListener('click', async () => {
  const copied = await copyText(redirectUriEl.textContent.trim());
  toast(copied ? 'Redirect URI copied' : 'Could not copy — select it manually');
});

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  hideLoginError();

  if (state.config?.configured) {
    window.location.assign('/auth/login');
    return;
  }

  const clientId = clientIdInput.value.trim();
  if (!/^[0-9a-f]{32}$/i.test(clientId)) {
    showLoginError(
      'That Client ID doesn’t look right. It should be 32 letters and numbers, with no spaces.'
    );
    clientIdInput.focus();
    return;
  }

  try {
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  } catch {
    // Not fatal: the login flow carries the ID in the URL.
  }

  window.location.assign(`/auth/login?client_id=${encodeURIComponent(clientId)}`);
});

logoutBtn.addEventListener('click', async () => {
  logoutBtn.disabled = true;
  closeStream();
  clearCachedResult();
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    // Reloading still clears the UI; the session cookie expires on its own.
  }
  window.location.reload();
});

/* ---------- Boot ---------- */

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get('error');

  if (params.has('error')) {
    params.delete('error');
    const clean = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
    window.history.replaceState(null, '', clean);
  }

  try {
    const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
    if (response.ok) applyConfig(await response.json());
  } catch {
    // The config screen still works with its default redirect URI.
  }

  try {
    const response = await fetch('/api/me', { headers: { Accept: 'application/json' } });
    if (response.ok) {
      const data = await response.json();
      showApp(data.profile, data.canWrite);
      const cached = readCachedResult(data.profile?.id);
      if (cached) showCachedResult(cached);
      else runAnalysis(false);
      return;
    }

    if (response.status === 429) {
      let message = 'Spotify is rate limiting this app. Wait a moment, then reload the page.';
      try {
        const data = await response.json();
        if (typeof data?.error === 'string') message = data.error;
      } catch {
        // Keep the generic rate-limit message.
      }
      showLogin(message);
      return;
    }
  } catch {
    // Fall through to the login view.
  }

  showLogin(oauthError || null);
}

boot();
