// NTS → Spotify · 100% cliente (GitHub Pages). Login con Spotify PKCE: sin secretos ni servidor.

const SCOPE = "playlist-modify-private playlist-modify-public";
const LS = {
  clientId: "nts2sp_client_id",
  token: "nts2sp_token",
  verifier: "nts2sp_verifier",
};

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
      client_id: localStorage.getItem(LS.clientId),
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

async function getToken() {
  const raw = localStorage.getItem(LS.token);
  if (!raw) return null;
  let tok = JSON.parse(raw);
  if (Date.now() > tok.expires_at) {
    if (!tok.refresh_token) return null;
    try {
      tok = await tokenRequest({
        client_id: localStorage.getItem(LS.clientId),
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
async function fetchJSON(url) {
  const attempts = [
    (u) => u,
    (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  ];
  let notFound = false;
  for (const wrap of attempts) {
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

async function fetchNtsEpisode(show, episode) {
  const base = `https://www.nts.live/api/v2/shows/${show}/episodes/${episode}`;
  const data = await fetchJSON(base);
  let results = data?.embeds?.tracklist?.results;
  if (!results || !results.length) {
    try { results = (await fetchJSON(base + "/tracklist"))?.results; } catch { /* nada */ }
  }
  const tracks = extractTracks(results);
  if (!tracks.length) throw new Error("Este episodio no tiene tracklist publicado en NTS.");
  return { name: data.name || episode, tracks };
}

// ---------- Spotify API ----------
async function sp(method, path, token, { params, json } = {}) {
  const url = new URL("https://api.spotify.com/v1" + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      body: json ? JSON.stringify(json) : undefined,
    });
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
    return res.status === 204 ? {} : res.json();
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
  onProgress("Leyendo el tracklist de NTS…");
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
    json: { name: `NTS: ${ep.name}`.slice(0, 100), description: `Importada desde ${url}`, public: false },
  });
  for (let i = 0; i < uris.length; i += 100) {
    await sp("POST", `/playlists/${pl.id}/items`, token, { json: { uris: uris.slice(i, i + 100) } });
  }
  return { name: pl.name, url: pl.external_urls.spotify, total: ep.tracks.length, matched: uris.length, missing };
}

// ---------- UI ----------
async function initUI() {
  const $ = (id) => document.getElementById(id);
  const setStatus = (text, isErr = false) => {
    $("status").textContent = text;
    $("status").className = isErr ? "err" : "";
  };

  $("redirect-uri").textContent = redirectUri();
  $("client-id").value = localStorage.getItem(LS.clientId) || "";

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

  $("copy-uri").onclick = async () => {
    try { await navigator.clipboard.writeText(redirectUri()); $("copy-uri").textContent = "Copiado"; } catch { /* sin permiso */ }
  };

  $("setup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = $("client-id").value.trim();
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
if (typeof module !== "undefined") module.exports = { parseNtsUrl, clean, extractTracks, b64url };
