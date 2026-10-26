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
  // Si el nombre ya trae la fecha (p. ej. "… 8th October 2026"), no la repetimos.
  const alreadyDated = date && String(name).includes(String(new Date(iso).getUTCFullYear()));
  const suffix = date && !alreadyDated ? ` · ${date}` : "";
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

// NTS tiene dos imágenes por episodio: "picture_*" (la pequeña, de primer plano) y "background_*"
// (la grande de fondo, con más contenido). Preferimos la de fondo, de mayor a menor tamaño.
const IMG_KEYS = [
  "background_large", "background_medium_large", "background_medium",
  "picture_large", "picture_medium_large", "picture_medium",
];
function pickImage(data) {
  const m = data?.media || {};
  for (const k of IMG_KEYS) if (typeof m[k] === "string" && m[k]) return m[k];
  // Plan B: cualquier URL de imagen de NTS dentro del JSON del episodio.
  const found = JSON.stringify(data || {}).match(/https?:\/\/media\d*\.ntslive\.co\.uk\/[^"'\s\\]+\.(?:jpe?g|png|webp)/i);
  return found ? found[0] : null;
}

// Plan C: la imagen que NTS pone en la propia página del episodio (og:image).
function ogImage(html) {
  const s = String(html);
  const m = s.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || s.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? m[1].replace(/&amp;/g, "&") : null;
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
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---------- coincidencia estricta ----------
// Solo se añade una canción si título y artista coinciden de verdad con lo que dice NTS.
const stripAccents = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");

function norm(s) {
  return stripAccents(s).toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ").trim()
    .replace(/^the /, "");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function sim(a, b) {
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

// Título "de fondo": sin paréntesis, sin feat. y sin sufijos tipo " - Remastered 2011".
const VERSION_RE = /\s+[-–—]\s+.*\b(?:remaster(?:ed)?|version|edit|mix|live|mono|stereo|single|bonus|deluxe|radio|original|\d{4})\b.*$/i;
function coreTitle(s) {
  return norm(clean(String(s)).replace(VERSION_RE, "")) || norm(s);
}

function containsWords(a, b) {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 4 && (" " + l + " ").includes(" " + s + " ");
}

function artistScore(ntsArtist, spotifyArtists) {
  const full = norm(ntsArtist);
  const parts = String(ntsArtist)
    .split(/\s*(?:,|&|\+|\/|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing|\bwith\b|\band\b|\bvs\.?)\s*/i)
    .map(norm).filter(Boolean);
  const mine = [full, ...parts];
  const theirs = spotifyArtists.map(norm).filter(Boolean);
  if (theirs.length > 1) theirs.push(norm(spotifyArtists.join(" and ")));
  let best = 0;
  for (const x of mine) {
    for (const y of theirs) {
      let sc = sim(x, y);
      if (containsWords(x, y)) sc = Math.max(sc, 0.9);
      if (sc > best) best = sc;
    }
  }
  return best;
}

function scoreCandidate(nts, item) {
  const titleSim = sim(coreTitle(nts.title), coreTitle(item.name));
  const artistSim = artistScore(nts.artist, (item.artists || []).map((a) => a.name));
  return { titleSim, artistSim, total: titleSim * 0.6 + artistSim * 0.4 };
}

const isAccepted = (s) => s.titleSim >= 0.92 && s.artistSim >= 0.85;
const isSimilar = (s) => s.titleSim >= 0.6 && s.artistSim >= 0.6;

function mismatchReason(s) {
  if (s.titleSim >= 0.92) return "el artista no coincide del todo, ¿mal escrito en NTS?";
  if (s.artistSim >= 0.85) return "el título no coincide del todo";
  return "ni el título ni el artista coinciden del todo";
}

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

async function fetchText(url) {
  for (const wrap of PROXIES) {
    try {
      const res = await fetch(wrap(url));
      if (res.ok) return await res.text();
    } catch { /* siguiente intento */ }
  }
  throw new Error("no se pudo leer la página");
}

// Para imágenes añadimos wsrv.nl, un proxy de imágenes con CORS abierto.
const BLOB_PROXIES = [
  (u) => u,
  (u) => "https://wsrv.nl/?output=jpg&w=1600&url=" + encodeURIComponent(u),
  (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  (u) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
  (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
];

async function fetchBlob(url) {
  for (const wrap of BLOB_PROXIES) {
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

// Paso 1: lee el episodio y descarga la imagen completa (sin tocarla).
async function prepare(url, onProgress) {
  const { show, episode } = parseNtsUrl(url);
  const cleanUrl = `https://www.nts.live/shows/${show}/episodes/${episode}`;
  onProgress("Leyendo el episodio de NTS…");
  const ep = await fetchNtsEpisode(show, episode);

  let image = ep.image;
  if (!image) {
    try { image = ogImage(await fetchText(cleanUrl)); } catch { /* sin imagen */ }
  }
  let bmp = null, imageError = "";
  if (image) {
    onProgress("Descargando la imagen…");
    console.log("[NTS→Spotify] imagen:", image);
    const blob = await fetchBlob(image);
    if (blob) {
      try { bmp = await createImageBitmap(blob); } catch { imageError = "no he podido leer la imagen descargada"; }
    } else {
      imageError = "no he podido descargar la imagen de NTS";
    }
  } else {
    imageError = "NTS no devuelve ninguna imagen para este episodio";
  }
  return { ep, cleanUrl, title: buildTitle(ep.name, ep.broadcast), bmp, imageError };
}

// ---------- Portada ----------
// st = { mode: "blur" | "crop" | "none", zoom: 1..3, cx, cy: centro del recorte (0..1) }
function clampCrop(st, bmp) {
  const side = Math.min(bmp.width, bmp.height) / st.zoom;
  const hx = side / 2 / bmp.width, hy = side / 2 / bmp.height;
  st.cx = clamp(st.cx, hx, 1 - hx);
  st.cy = clamp(st.cy, hy, 1 - hy);
}

// Dibuja la portada tal y como se subirá. Sirve para la vista previa y para exportar.
function renderCover(canvas, bmp, st) {
  const size = canvas.width;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#161614";
  ctx.fillRect(0, 0, size, size);
  if (!bmp) return;

  if (st.mode === "crop") {
    clampCrop(st, bmp);
    const side = Math.min(bmp.width, bmp.height) / st.zoom;
    const sx = st.cx * bmp.width - side / 2;
    const sy = st.cy * bmp.height - side / 2;
    ctx.drawImage(bmp, sx, sy, side, side, 0, 0, size, size);
    return;
  }

  // Difuminado: la imagen entera centrada sobre una versión borrosa de sí misma.
  // (reducir y ampliar funciona en todos los navegadores, también iOS)
  const s = Math.min(bmp.width, bmp.height);
  const tiny = document.createElement("canvas");
  tiny.width = tiny.height = 24;
  tiny.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 24, 24);
  ctx.drawImage(tiny, 0, 0, size, size);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, size, size);
  const k = Math.min(size / bmp.width, size / bmp.height);
  const w = bmp.width * k, h = bmp.height * k;
  ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
}

// Spotify exige JPEG en base64 de como mucho 256 KB.
async function exportCover(bmp, st) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 640;
  renderCover(canvas, bmp, st);
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

// Devuelve { ok: true } o { ok: false, reason } para poder decirle al usuario qué ha fallado.
async function uploadCover(token, playlistId, bmp, st) {
  let b64 = null;
  try { b64 = await exportCover(bmp, st); } catch (e) { console.error(e); }
  if (!b64) return { ok: false, reason: "no he podido procesar la imagen" };
  try {
    await sp("PUT", `/playlists/${playlistId}/images`, token, { body: b64, contentType: "image/jpeg" });
    return { ok: true };
  } catch (e) {
    console.error(e);
    return {
      ok: false,
      reason: e.status
        ? e.message
        : `el navegador ha bloqueado la subida a Spotify (${e.message})`,
    };
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
  const nts = { artist, title };
  const seen = new Set();
  let best = null;
  for (const q of queries) {
    const data = await sp("GET", "/search", token, { params: { q, type: "track", limit: 5 } });
    for (const item of data.tracks?.items || []) {
      if (seen.has(item.uri)) continue;
      seen.add(item.uri);
      const sc = scoreCandidate(nts, item);
      if (!best || sc.total > best.sc.total) best = { sc, item };
    }
    if (best && isAccepted(best.sc)) break;
  }
  if (best && isAccepted(best.sc)) return { status: "ok", uri: best.item.uri };
  if (best && isSimilar(best.sc)) {
    return {
      status: "similar",
      suggestion: {
        uri: best.item.uri,
        name: best.item.name,
        artists: (best.item.artists || []).map((x) => x.name).join(", "),
        url: best.item.external_urls?.spotify || "",
        reason: mismatchReason(best.sc),
      },
    };
  }
  return { status: "none" };
}

// Paso 2: busca las canciones, crea la playlist y sube la portada elegida.
async function createPlaylist(prep, token, st, onProgress) {
  const { ep, cleanUrl } = prep;
  const uris = [], unmatched = [];
  for (let i = 0; i < ep.tracks.length; i++) {
    const t = ep.tracks[i];
    onProgress(`Buscando en Spotify… ${i + 1}/${ep.tracks.length}`);
    const r = await findTrack(token, t.artist, t.title);
    if (r.status === "ok") {
      if (!uris.includes(r.uri)) uris.push(r.uri);
    } else {
      unmatched.push({ artist: t.artist, title: t.title, suggestion: r.suggestion || null });
    }
  }
  if (!uris.length && !unmatched.some((u) => u.suggestion)) {
    throw new Error("No he encontrado ninguna canción que coincida en Spotify.");
  }

  onProgress("Creando la playlist…");
  const pl = await sp("POST", "/me/playlists", token, {
    json: { name: prep.title, description: buildDescription(ep.description, cleanUrl), public: false },
  });
  for (let i = 0; i < uris.length; i += 100) {
    await sp("POST", `/playlists/${pl.id}/items`, token, { json: { uris: uris.slice(i, i + 100) } });
  }

  let cover;
  if (st.mode === "none") {
    cover = { skipped: true };
  } else if (!prep.bmp) {
    cover = { ok: false, reason: prep.imageError || "no hay imagen" };
  } else {
    onProgress("Subiendo la portada…");
    cover = await uploadCover(token, pl.id, prep.bmp, st);
  }
  return {
    id: pl.id, name: pl.name, url: pl.external_urls.spotify,
    total: ep.tracks.length, matched: uris.length, unmatched, cover,
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

  // ----- editor de portada -----
  const canvas = $("cover");
  const st = { mode: "blur", zoom: 1, cx: 0.5, cy: 0.5 };
  let cur = null; // episodio preparado

  const draw = () => renderCover(canvas, cur?.bmp || null, st);

  function setMode(mode) {
    st.mode = mode;
    document.querySelectorAll("#seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $("crop-controls").classList.toggle("hidden", mode !== "crop" || !cur?.bmp);
    $("cover-wrap").classList.toggle("hidden", mode === "none" || !cur?.bmp);
    canvas.classList.toggle("grab", mode === "crop");
    draw();
  }

  function setImage(bmp, error = "") {
    cur.bmp = bmp;
    cur.imageError = error;
    st.zoom = 1; st.cx = 0.5; st.cy = 0.5;
    $("zoom").value = 1;
    $("cover-msg").textContent = bmp ? "" : `Sin imagen: ${error}. Puedes elegir otra o seguir sin portada.`;
    // Casi cuadrada: recortar apenas pierde nada. Apaisada o vertical: mejor entera con fondo difuminado.
    const nearSquare = bmp && Math.abs(bmp.width / bmp.height - 1) < 0.05;
    setMode(nearSquare ? "crop" : "blur");
  }

  document.querySelectorAll("#seg button").forEach((b) => {
    b.addEventListener("click", () => setMode(b.dataset.mode));
  });

  $("zoom").addEventListener("input", () => {
    st.zoom = Number($("zoom").value);
    draw();
  });

  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (st.mode !== "crop" || !cur?.bmp) return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const bmp = cur.bmp;
    const k = (Math.min(bmp.width, bmp.height) / st.zoom) / canvas.getBoundingClientRect().width; // px de origen por px de pantalla
    st.cx -= ((e.clientX - drag.x) * k) / bmp.width;
    st.cy -= ((e.clientY - drag.y) * k) / bmp.height;
    drag = { x: e.clientX, y: e.clientY };
    draw();
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  $("pick-img").addEventListener("click", () => $("own-img").click());
  $("own-img").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file || !cur) return;
    try { setImage(await createImageBitmap(file)); }
    catch { $("cover-msg").textContent = "No he podido leer ese archivo como imagen."; }
    e.target.value = "";
  });

  // ----- canciones que no se han añadido -----
  const reloadEmbed = () => {
    const f = $("r-embed");
    const src = f.src;
    f.removeAttribute("src");
    setTimeout(() => { f.src = src; }, 100);
  };

  function extLink(label, href) {
    const a = document.createElement("a");
    a.className = "mini";
    a.textContent = label;
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  }

  function renderUnmatched(list, playlistId) {
    $("r-un").replaceChildren();
    $("r-un-box").classList.toggle("hidden", !list.length);
    $("r-un-title").textContent = `${list.length} sin añadir (no coinciden tal cual con lo que dice NTS)`;
    for (const u of list) {
      const card = document.createElement("div");
      card.className = "un";
      const h = document.createElement("div");
      h.className = "un-title";
      h.textContent = `${u.artist} – ${u.title}`;
      const p = document.createElement("div");
      p.className = "hint";
      const actions = document.createElement("div");
      actions.className = "un-actions";

      if (u.suggestion) {
        const s = u.suggestion;
        p.textContent = `Lo más parecido en Spotify: ${s.artists} – ${s.name} (${s.reason}).`;
        const add = document.createElement("button");
        add.type = "button";
        add.className = "mini";
        add.textContent = "Añadir esa";
        add.onclick = async () => {
          add.disabled = true;
          add.textContent = "Añadiendo…";
          try {
            const tk = await getToken();
            if (!tk) { location.reload(); return; }
            await sp("POST", `/playlists/${playlistId}/items`, tk, { json: { uris: [s.uri] } });
            add.textContent = "Añadida ✓";
            reloadEmbed();
          } catch (err) {
            add.disabled = false;
            add.textContent = "Añadir esa";
            setStatus(err.message, true);
          }
        };
        actions.append(add);
        if (s.url) actions.append(extLink("Ver en Spotify", s.url));
      } else {
        p.textContent = "No he encontrado nada parecido en Spotify.";
      }

      const q = encodeURIComponent(`${u.artist} ${u.title}`);
      actions.append(
        extLink("YouTube", `https://www.youtube.com/results?search_query=${q}`),
        extLink("Bandcamp", `https://bandcamp.com/search?q=${q}`),
        extLink("Google", `https://www.google.com/search?q=${q}`),
      );
      card.append(h, p, actions);
      $("r-un").append(card);
    }
  }

  // ----- paso 1: cargar episodio -----
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("go");
    btn.disabled = true;
    $("result").classList.add("hidden");
    $("editor").classList.add("hidden");
    $("r-embed").removeAttribute("src");
    try {
      cur = await prepare($("url").value, (m) => setStatus(m));
      setStatus("");
      $("e-title").textContent = cur.title;
      $("e-count").textContent = `${cur.ep.tracks.length} temas en el tracklist de NTS`;
      setImage(cur.bmp, cur.imageError);
      $("editor").classList.remove("hidden");
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // ----- paso 2: crear playlist -----
  $("create").addEventListener("click", async () => {
    if (!cur) return;
    const btn = $("create");
    btn.disabled = true;
    try {
      const tk = await getToken();
      if (!tk) { location.reload(); return; }
      const data = await createPlaylist(cur, tk, st, (m) => setStatus(m));
      setStatus("");
      $("editor").classList.add("hidden");
      $("r-name").textContent = data.name;
      $("r-count").textContent = `${data.matched} de ${data.total} canciones añadidas`
        + (data.unmatched.length ? ` · ${data.unmatched.length} sin añadir` : "");
      $("r-note").textContent = data.cover.skipped
        ? "Playlist creada sin portada."
        : data.cover.ok
          ? "Portada subida (Spotify puede tardar un poco en mostrarla)."
          : `Portada no subida: ${data.cover.reason}. La playlist está creada igualmente.`;
      $("r-link").href = data.url;
      $("r-embed").src = `https://open.spotify.com/embed/playlist/${data.id}?utm_source=generator`;
      renderUnmatched(data.unmatched, data.id);
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
  module.exports = { parseNtsUrl, clean, extractTracks, b64url, stripHtml, formatDate, buildTitle, buildDescription, pickImage, ogImage, clampCrop, norm, coreTitle, artistScore, scoreCandidate, isAccepted, isSimilar, mismatchReason };
}
