// NTS → Spotify · 100% cliente (GitHub Pages). Login con Spotify PKCE: sin secretos ni servidor.

// Pega aquí tu Client ID de Spotify para no tener que introducirlo en cada dispositivo.
// No es un secreto (el flujo PKCE no usa Client Secret), así que puede ir en el repo público.
const CLIENT_ID = "";

const SCOPE = "playlist-modify-private playlist-modify-public ugc-image-upload";
const LS = {
  clientId: "nts2sp_client_id",
  token: "nts2sp_token",
  verifier: "nts2sp_verifier",
};

const getClientId = () => CLIENT_ID || localStorage.getItem(LS.clientId) || "";

// ---------- utilidades puras ----------
function parseNtsUrl(url) {
  const m = String(url).trim().match(/nts\.live\/shows\/([^/?#]+)\/episodes\/([^/?#]+)/);
  if (!m) {
    throw new Error("Ese enlace no parece un episodio de NTS (nts.live/shows/…/episodes/…).");
  }
  return { show: m[1], episode: m[2] };
}

function clean(s) {
  return s
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/\s+(feat\.?|ft\.?|featuring)\s.*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTracks(results) {
  return (results || [])
    .map((t) => ({ artist: (t.artist || "").trim(), title: (t.title || "").trim() }))
    .filter((t) => t.artist && t.title);
}

function stripHtml(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDate(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return "";
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .replace(/\./g, "");
}

function buildTitle(name, iso) {
  const date = formatDate(iso);
  const suffix = date ? ` · ${date}` : "";
  return `NTS: ${name}`.slice(0, 100 - suffix.length).trimEnd() + suffix;
}

function buildDescription(desc, url) {
  const max = 300;
  const link = url.length <= 120 ? ` — ${url}` : "";
  let d = stripHtml(desc);
  if (d.length > max - link.length) d = d.slice(0, max - link.length - 1).trimEnd() + "…";
  if (!d) return url.length <= 120 ? `Importada desde ${url}` : "";
  return d + link;
}

const IMG_KEYS = [
  "picture_large", "background_large", "picture_medium_large",
  "background_medium_large", "picture_medium", "background_medium",
];
function pickImage(data) {
  const m = data?.media || {};
  for (const k of IMG_KEYS) if (m[k]) return m[k];
  return null;
}

function redirectUri() {
  const { origin, pathname } = window.location;
  return origin + pathname.replace(/index\.html$/, "");
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(len = 64) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return b64url(bytes).slice(0, len);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Spotify auth (PKCE) ----------
async function login(clientId) {
  localStorage.setItem(LS.clientId, clientId);
  const verifier = randomString(64);
  localStorage.setItem(LS.verifier, verifier);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPE,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location.href = "https://accounts.spotify.com/authorize?" + q;
}

async function tokenRequest(params) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "Error de autenticación");
  const old = JSON.parse(localStorage.getItem(LS.token) || "{}");
  const tok = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || old.refresh_token,
    expires_at: Date.now() + (data.expires_in - 30) * 1000,
    scope: SCOPE,
  };
  localStorage.setItem(LS.token, JSON.stringify(tok));
  return tok;
}

async function handleRedirect() {
  const p = new URLSearchParams(window.location.search);
  if (!p.has("code") && !p.has("error")) return null;
  history.replaceState({}, "", redirectUri());
  if (p.has("error")) return "Spotify ha cancelado el acceso: " + p.get("error");
  try {
    await tokenRequest({
      client_id: getClientId(),
      grant_type: "authorization_code",
      code: p.get("code"),
      redirect_uri: redirectUri(),
      code_verifier: localStorage.getItem(LS.verifier),
    });
  } catch (e) {
    return e.message;
  }
  return null;
}

// true si hay sesión guardada pero con permisos antiguos (hay que volver a conectar)
function needsReauth() {
  const raw = localStorage.getItem(LS.token);
  return !!raw && JSON.parse(raw).scope !== SCOPE;
}

async function getToken() {
  const raw = localStorage.getItem(LS.token);
  if (!raw) return null;
  let tok = JSON.parse(raw);
  if (tok.scope !== SCOPE) return null;
  if (Date.now() > tok.expires_at) {
    if (!tok.refresh_token) return null;
    try {
      tok = await tokenRequest({
        client_id: getClientId(),
        grant_type: "refresh_token",
        refresh_token: tok.refresh_token,
      });
    } catch {
      localStorage.removeItem(LS.token);
      return null;
    }
  }
  return tok.access_token;
}

// ---------- NTS ----------
// Intenta directo y, si el navegador lo bloquea por CORS, vía proxies públicos.
const PROXIES = [
  (u) => u,
  (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
  (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
];

async function fetchJSON(url) {
  let notFound = false;
  for (const wrap of PROXIES) {
    try {
      const res = await fetch(wrap(url));
      if (res.status === 404) { notFound = true; continue; }
      if (!res.ok) continue;
      return await res.json();
    } catch { /* siguiente intento */ }
  }
  if (notFound) throw new Error("No encuentro ese episodio en NTS. Revisa el enlace.");
  throw new Error("No he podido leer NTS desde el navegador. Prueba otra vez en un rato.");
}

async function fetchBlob(url) {
  for (const wrap of PROXIES) {
    try {
      const res = await fetch(wrap(url));
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size > 0 && (!blob.type || blob.type.startsWith("image/"))) return blob;
    } catch { /* siguiente intento */ }
  }
  return null;
}

async function fetchNtsEpisode(show, episode) {
  const base = `https://www.nts.live/api/v2/shows/${show}/episodes/${episode}`;
  const data = await fetchJSON(base);
  let results = data?.embeds?.tracklist?.results;
  if (!results || !results.length) {
    try { results = (await fetchJSON(base + "/tracklist"))?.results; } catch { /* nada */ }
  }
  const tracks = extractTracks(results);
  if (!tracks.length) throw new Error("Este episodio no tiene tracklist publicado en NTS.");
  return {
    name: data.name || episode,
    description: data.description || "",
    broadcast: data.broadcast || "",
    image: pickImage(data),
    tracks,
  };
}

// ---------- Portada ----------
// Spotify exige JPEG en base64 de como mucho 256 KB.
async function coverToJpegBase64(blob) {
  const bmp = await createImageBitmap(blob);
  const side = Math.min(bmp.width, bmp.height);
  const size = Math.min(side, 640);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas.getContext("2d").drawImage(
    bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size,
  );
  for (const q of [0.9, 0.8, 0.7, 0.55, 0.4, 0.3]) {
    const out = await new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
    if (out && out.size <= 180 * 1024) {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(out);
      });
      return dataUrl.split(",")[1];
    }
  }
  return null;
}

async function uploadCover(token, playlistId, imageUrl) {
  try {
    const blob = await fetchBlob(imageUrl);
    if (!blob) return false;
    const b64 = await coverToJpegBase64(blob);
    if (!b64) return false;
    await sp("PUT", `/playlists/${playlistId}/images`, token, { body: b64, contentType: "image/jpeg" });
    return true;
  } catch {
    return false;
  }
}

// ---------- Spotify API ----------
async function sp(method, path, token, { params, json, body, contentType } = {}) {
  const url = new URL("https://api.spotify.com/v1" + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = { Authorization: "Bearer " + token };
  let payload;
  if (body !== undefined) { payload = body; headers["Content-Type"] = contentType; }
  else if (json) { payload = JSON.stringify(json); headers["Content-Type"] = "application/json"; }

  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { method, headers, body: payload });
    if (res.status === 429) {
      await sleep((Math.min(Number(res.headers.get("Retry-After") || 2), 10) + 1) * 1000);
      continue;
    }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error?.message || msg; } catch { /* sin cuerpo */ }
      const err = new Error(`Spotify (${res.status}): ${msg}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  throw new Error("Spotify está limitando las peticiones. Prueba en un minuto.");
}

async function findTrack(token, artist, title) {
  const a = clean(artist), t = clean(title);
  const firstArtist = a.split("&")[0].split(",")[0].trim();
  const queries = [`track:"${t}" artist:"${a}"`, `${a} ${t}`, `${firstArtist} ${t}`];
  for (const q of queries) {
    const data = await sp("GET", "/search", token, { params: { q, type: "track", limit: 1 } });
    const item = data.tracks?.items?.[0];
    if (item) return item.uri;
  }
  return null;
}

async function convert(url, token, onProgress) {
  const { show, episode } = parseNtsUrl(url);
  const cleanUrl = `https://www.nts.live/shows/${show}/episodes/${episode}`;
  onProgress("Leyendo el episodio de NTS…");
  const ep = await fetchNtsEpisode(show, episode);

  const uris = [], missing = [];
  for (let i = 0; i < ep.tracks.length; i++) {
    const t = ep.tracks[i];
    onProgress(`Buscando en Spotify… ${i + 1}/${ep.tracks.length}`);
    const uri = await findTrack(token, t.artist, t.title);
    if (!uri) missing.push(`${t.artist} – ${t.title}`);
    else if (!uris.includes(uri)) uris.push(uri);
  }
  if (!uris.length) throw new Error("No he encontrado ninguna canción en Spotify.");

  onProgress("Creando la playlist…");
  const pl = await sp("POST", "/me/playlists", token, {
    json: {
      name: buildTitle(ep.name, ep.broadcast),
      description: buildDescription(ep.description, cleanUrl),
      public: false,
    },
  });
  for (let i = 0; i < uris.length; i += 100) {
    await sp("POST", `/playlists/${pl.id}/items`, token, { json: { uris: uris.slice(i, i + 100) } });
  }

  let cover = null; // null = el episodio no tiene imagen
  if (ep.image) {
    onProgress("Subiendo la portada…");
    cover = await uploadCover(token, pl.id, ep.image);
  }
  return {
    name: pl.name, url: pl.external_urls.spotify,
    total: ep.tracks.length, matched: uris.length, missing, cover,
  };
}

// ---------- UI ----------
async function initUI() {
  const $ = (id) => document.getElementById(id);
  const setStatus = (text, isErr = false) => {
    $("status").textContent = text;
    $("status").className = isErr ? "err" : "";
  };

  $("redirect-uri").textContent = redirectUri();
  $("client-id").value = getClientId();
  if (CLIENT_ID) {
    $("setup-steps").classList.add("hidden");
    $("client-id-field").classList.add("hidden");
    $("client-id").required = false;
  }

  const redirectError = await handleRedirect();
  const token = await getToken();

  $("setup").classList.toggle("hidden", !!token);
  $("form").classList.toggle("hidden", !token);
  $("auth").replaceChildren();
  if (token) {
    const out = document.createElement("a");
    out.href = "#";
    out.textContent = "salir";
    out.onclick = (e) => {
      e.preventDefault();
      localStorage.removeItem(LS.token);
      location.reload();
    };
    $("auth").append("Spotify conectado · ", out);
  }
  if (redirectError) setStatus(redirectError, true);
  else if (!token && needsReauth()) {
    setStatus("Hay un permiso nuevo (subir la portada). Vuelve a conectar Spotify, solo hace falta una vez.");
  }

  $("copy-uri").onclick = async () => {
    try { await navigator.clipboard.writeText(redirectUri()); $("copy-uri").textContent = "Copiado"; } catch { /* sin permiso */ }
  };

  $("setup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = getClientId() || $("client-id").value.trim();
    if (id) login(id);
  });

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("go");
    btn.disabled = true;
    $("result").classList.add("hidden");
    try {
      const tk = await getToken();
      if (!tk) { location.reload(); return; }
      const data = await convert($("url").value, tk, (m) => setStatus(m));
      setStatus("");
      $("r-name").textContent = data.name;
      $("r-count").textContent = `${data.matched} de ${data.total} canciones encontradas en Spotify`;
      $("r-note").textContent =
        data.cover === false ? "No he podido subir la portada (la playlist está creada igualmente)."
        : data.cover === null ? "Este episodio no tiene imagen en NTS."
        : "";
      $("r-link").href = data.url;
      const box = $("r-missing-box");
      if (data.missing.length) {
        $("r-missing-title").textContent = `${data.missing.length} sin encontrar`;
        $("r-missing").replaceChildren(...data.missing.map((m) => {
          const li = document.createElement("li");
          li.textContent = m;
          return li;
        }));
        box.classList.remove("hidden");
      } else {
        box.classList.add("hidden");
      }
      $("result").classList.remove("hidden");
    } catch (err) {
      let msg = err.message;
      if (err.status === 403) {
        msg += " — En modo desarrollo, Spotify exige Premium al dueño de la app y que tu usuario esté añadido en el dashboard.";
      }
      setStatus(msg, true);
    } finally {
      btn.disabled = false;
    }
  });
}

if (typeof document !== "undefined") initUI();
if (typeof module !== "undefined") {
  module.exports = { parseNtsUrl, clean, extractTracks, b64url, stripHtml, formatDate, buildTitle, buildDescription, pickImage };
}
