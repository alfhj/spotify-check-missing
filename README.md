# Spotify Library Diff

A small local web app that audits a Spotify library and shows two kinds of gaps:

1. **Missing liked songs** — tracks inside your liked albums that aren't in your **Liked Songs**.
2. **Unliked albums** — albums behind your liked songs that aren't saved to **Liked Albums**.

The app logs in with Spotify using OAuth + PKCE, requests read-only library access by default, and renders the diff in a browser UI with search, progress, album grouping, and JSON export. An optional change mode can like songs and save albums from the results.

```
Liked albums → their tracks − Liked Songs = songs to like
Liked songs  → their albums − Liked Albums = albums to save
```

## Quick start

Requires **Node.js 18+**.

```bash
npm install
npm start
```

Open <http://127.0.0.1:8888>.

### 1. Create a Spotify app

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and choose **Create app**.
2. Fill in the app details. The name and description can be anything; use these values for the rest:

   | Field | Value |
   | --- | --- |
   | App name | `Spotify Library Diff` (or any name) |
   | App description | `Local read-only library audit` (or any description) |
   | Website | `http://127.0.0.1:8888` |
   | Redirect URI | `http://127.0.0.1:8888/auth/callback` |
   | Which API/SDKs are you planning to use? | **Web API** only |

3. **API/SDK selection:** check **Web API** only. Do **not** check **Ads API**, **Web Playback SDK**, **iOS**, or **Android**. This tool calls the Spotify Web API directly and uses no Spotify SDK.
4. If you edit the app later, add the redirect URI under **Settings** exactly as shown:
   ```
   http://127.0.0.1:8888/auth/callback
   ```
   Spotify requires a loopback IP (`127.0.0.1`), not `localhost`.
5. Keep the app in **Development Mode**. The Spotify account that owns the app always has access, and you can add up to a few other users under **User Management**. Development Mode apps created or migrated after early 2026 require the owner to have an active Spotify Premium subscription.

### 2. Connect

Either paste the app's **Client ID** into the setup screen, or put it in a `.env` file:

```bash
cp .env.example .env
```

```dotenv
SPOTIFY_CLIENT_ID=your_32_character_client_id
```

Restart the server if you edit `.env`, then click **Connect Spotify**.

No client secret is needed — the app uses the Authorization Code flow with PKCE.

The latest audit is cached in your browser, so reloading the page shows it instantly. Use **Refresh** in the app header to fetch fresh data from Spotify.

## Making changes (optional)

The default login only asks for read-only access. To like songs or save albums directly from the diff:

1. Turn on **Allow changes** in the app header.
2. The app reconnects to Spotify and asks for the additional `user-library-modify` scope.
3. Use **Like** on a missing song (or **Like all** for an album group), and **Save album** on an unliked album.

Actions apply immediately. Buttons switch to **Liked ✓** or **Saved ✓**; click them again to undo the change. The cached audit is invalidated after every change, so **Refresh** performs a fresh comparison.

Turn **Allow changes** off to hide the action buttons. To drop the write permission entirely, log out and connect again without enabling changes.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` | — | Spotify app client ID. Can be omitted and pasted in the UI. |
| `PORT` | `8888` | Port for the local server. |
| `HOST` | `127.0.0.1` | Bind address. Keep loopback for local use. |
| `PUBLIC_URL` | `http://127.0.0.1:$PORT` | Public base URL used to build the redirect URI. |
| `REDIRECT_URI` | `$PUBLIC_URL/auth/callback` | Exact redirect URI registered in the Spotify dashboard. |

If you change `PORT`, update the redirect URI in the Spotify dashboard too.

## How the comparison works

- All pages of `GET /me/tracks` and `GET /me/albums` are loaded (50 items per page).
- Album track lists arrive inside the saved-albums response. Paging is followed (via the still-supported `GET /albums/{id}/tracks`) only for albums longer than one page or responses without an embedded list.
- A saved album track is **missing** when its Spotify **track ID** is not in Liked Songs.
- A liked song's album is **unliked** when its **album ID** is not in Liked Albums.
- Different releases of the same recording (studio, live, greatest-hits) have different track IDs on Spotify, so they count separately. This is deliberate: it reflects what Spotify would actually add to Liked Songs.
- Local files and unavailable items are skipped and reported in the summary.

The server handles Spotify rate limits with `Retry-After` waits and backoff, and refreshes expired access tokens automatically.

## Notes

- **Read-only by default:** the initial login requests `user-library-read` and `user-read-private`. The app cannot modify your library until you explicitly enable changes and reconnect, which adds `user-library-modify`.
- **February 2026 API:** library changes use the generic `PUT`/`DELETE /me/library` endpoints with `spotify:track:` / `spotify:album:` URIs, batched 40 at a time, as required for Development Mode apps.
- **In-memory sessions:** tokens live in the Node process only; nothing is written to the server. The latest diff is cached in your browser's `localStorage` for the current Spotify account and is cleared on logout or after a change.
- The server caches results per session, and the browser keeps the latest result across page reloads. **Refresh** fetches fresh data and replaces the cached result when it completes.
- The UI is served from the same local server, so no data is sent anywhere except directly to Spotify's API.
- The server binds to `127.0.0.1` by default and is not intended to be exposed publicly.

## Troubleshooting

- **`INVALID_CLIENT: Invalid redirect URI`** — The redirect URI in the app settings must match the one shown in the UI exactly, including the port. Use `127.0.0.1`, not `localhost`.
- **`403` / “user not registered”** — Add the Spotify account under **User Management** in the app dashboard, and make sure the app owner's Premium subscription is active (required for Development Mode apps).
- **Rate limited (`429`)** — The app respects Spotify's `Retry-After`, retries automatically when the wait is reasonable, and shares the cooldown across concurrent requests. If Spotify asks for a long wait, the app reports the wait time instead of appearing to hang. Wait as instructed, then retry. Large libraries may take a few minutes.
- **Changes say the login is read-only (`403 write_scope_missing`)** — Turn on **Allow changes** again. The app reconnects and asks Spotify for the `user-library-modify` scope.
- **Login loop or expired session** — Restarting the server clears all sessions. Run the audit again and log in once more.

## Development

```bash
npm run dev   # restart on file changes
npm test      # unit tests for the diff logic
```

Project layout:

```
src/server.js      Express server, OAuth routes, SSE analysis stream, library changes
src/spotify.js     Spotify API client with refresh + rate-limit retries
src/analysis.js    Library diff computation
src/library.js     Save/remove tracks and albums with batching and validation
public/            Web UI (HTML/CSS/vanilla JS)
test/              Node test runner tests with a fake Spotify API
```
