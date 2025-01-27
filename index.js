const crypto = require("node:crypto");
const EventEmitter = require("node:events");
const querystring = require("querystring");
const express = require("express");
const axios = require("axios");
const open = require("open").default;
require("dotenv").config();

const app = express();
const port = 8888;
const urlBase = "https://api.spotify.com/v1/me";
const redirectUri = "http://localhost:8888/callback";
const tokenEmitter = new EventEmitter();
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Client ID and Client Secret must be set.");
  process.exit(1);
}

app.get("/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const scope = "playlist-read-private user-library-read";
  const authUrl =
    "https://accounts.spotify.com/authorize?" +
    querystring.stringify({
      response_type: "code",
      client_id: clientId,
      scope: scope,
      redirect_uri: redirectUri,
      state: state,
    });
  res.redirect(authUrl);
});

app.get("/callback", async (req, res) => {
  const code = req.query.code || null;
  const tokenUrl = "https://accounts.spotify.com/api/token";
  const authOptions = {
    method: "post",
    url: tokenUrl,
    data: querystring.stringify({
      code: code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
    headers: {
      Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };

  try {
    const response = await axios(authOptions);
    const accessToken = response.data.access_token;
    tokenEmitter.emit("tokenSet", accessToken);
    res.send("Success");
  } catch (error) {
    console.error("Error getting tokens:", error);
    res.send("Error getting tokens");
  }
});

const server = app.listen(port, async () => {
  console.log(`Server running at http://localhost:${port}/login`);
  await open(`http://localhost:${port}/login`);
});

tokenEmitter.on("tokenSet", (token) => {
  run(token);
});

const printError = (error) => {
  if (error.response) {
    console.log(error.response.data);
    console.log(error.response.status);
    console.log(error.response.headers);
  } else if (error.request) {
    console.log(error.request);
  } else {
    console.log("Error", error.message);
  }
  console.log(error.config);
  throw new Error("Error");
};

const getItemsPage = async (url, token) =>
  await axios
    .get(url, {
      params: {
        limit: 50,
      },
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    .then((res) => res.data)
    .catch((error) => printError(error));

const getItems = async (url, token, log) => {
  let nextUrl = url;
  const totalItems = [];
  while (nextUrl) {
    const data = await getItemsPage(nextUrl, token);
    log && console.log(`Got item ${data.offset + data.items.length} of ${data.total}`);
    totalItems.push(...data.items);
    nextUrl = data.next;
  }
  return totalItems;
};

const compareTracksToAlbums = (tracks, albums) =>
  tracks
    .filter((track) => albums.every((album) => !album.tracks.some((albumTrack) => albumTrack.id === track.id)))
    .map((track) => track.album)
    .reduce(
      (total, current) => (total.some((album) => album && album.id === current.id) ? total : total.concat(current)),
      []
    )
    .map((album) => album.name + " (" + album.artists[0].name + ")");

const compareAlbumsToTracks = (tracks, albums) =>
  albums
    .filter((album) => album.tracks.some((albumTrack) => !tracks.some((track) => track.id === albumTrack.id)))
    .map((album) => album.name + " (" + album.artists[0].name + ")");

const run = async (token) => {
  console.log(`Token: ${token}`);

  console.log("Getting liked songs...");
  const tracks = (await getItems(`${urlBase}/tracks`, token, true)).map((t) => t.track);

  console.log();
  console.log("Getting albums...");
  const partialAlbums = (await getItems(`${urlBase}/albums`, token, true)).map((a) => a.album);

  console.log();
  console.log("Getting missing album tracks...");
  const albums = await Promise.all(
    partialAlbums.map(async (album) => {
      const albumTracks =
        album.tracks && album.tracks.total > album.tracks.limit
          ? await getItems(album.tracks.href, token, false)
          : album.tracks.items;
      album.tracks = albumTracks;
      return album;
    })
  );

  console.log();
  console.log("Liked albums which contain songs not in library:");
  console.log(compareAlbumsToTracks(tracks, albums).join("\n"));

  console.log();
  console.log("Albums which contains liked tracks but have not been added to library:");
  console.log(compareTracksToAlbums(tracks, albums).join("\n"));

  server.close();
};
