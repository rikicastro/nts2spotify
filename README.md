# NTS → Spotify

Webapp estática: pegas el enlace de un episodio de NTS y crea una playlist privada en tu Spotify con su tracklist. Corre entera en el navegador (login con Spotify PKCE), sin servidor ni secretos, así que se puede publicar gratis en GitHub Pages.

## Publicar en GitHub Pages

1. Crea un repositorio nuevo en GitHub (por ejemplo `nts2spotify`) y sube `index.html`, `app.js` y `.nojekyll`.
2. En el repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, rama `main`, carpeta `/ (root)` → **Save**.
3. En un minuto tendrás la web en `https://TU-USUARIO.github.io/nts2spotify/`.

## Configurar Spotify (una sola vez)

1. Entra en https://developer.spotify.com/dashboard y crea una app (marca *Web API*).
2. Abre tu web publicada: te muestra la **Redirect URI** exacta. Cópiala en *Settings → Redirect URIs* de la app de Spotify y guarda.
3. Pega el **Client ID** en la web y pulsa *Conectar Spotify*. Se guarda solo en tu navegador.

## Sin pegar el Client ID en cada dispositivo

El Client ID no es un secreto (el flujo PKCE no usa Client Secret). Pégalo entre las comillas de `const CLIENT_ID = "";` al principio de `app.js` y vuelve a subir el archivo. Desde entonces, en cualquier móvil u ordenador solo tienes que pulsar *Conectar Spotify* la primera vez; la sesión se mantiene sola en ese navegador.

## Qué copia a Spotify

- **Título:** `NTS: nombre del episodio · fecha de emisión`.
- **Descripción:** la del episodio (recortada a 300 caracteres) más el enlace de NTS.
- **Portada:** descarga la imagen completa de NTS (la grande de fondo) y te deja elegir cómo quieres que quede: **entera con fondo difuminado**, **recortada a 1:1 eligiendo tú el encuadre** (arrastras la imagen y ajustas el zoom) o **sin portada**. También puedes usar otra imagen tuya. Se sube como JPEG de 640×640. Necesita el permiso `ugc-image-upload`; si ya habías conectado antes, te pedirá reconectar una vez.

## Coincidencias estrictas

Una canción solo se añade si el título y el artista coinciden de verdad con lo que dice NTS (ignorando mayúsculas, acentos, paréntesis y sufijos tipo "Remastered"). Las que no coinciden no se añaden: te aparecen debajo con lo más parecido que ha encontrado Spotify (por si en NTS está mal escrito), un botón para añadirla tú si quieres, y enlaces para buscarla en YouTube, Bandcamp o Google.

## Notas

- Desde febrero de 2026, las apps de Spotify en modo desarrollo exigen que el dueño de la app tenga **Premium** y limitan los usuarios (5 en apps nuevas). Para uso personal basta.
- NTS no está pensado para consumirse desde otras webs: la app intenta la API directa y, si el navegador la bloquea (CORS), usa proxies públicos. Si algún día falla la lectura, revisa `fetchJSON` en `app.js`.
- Los temas poco comerciales (white labels, bootlegs, edits) suelen no estar en Spotify, así que algunos faltarán. La web te los lista.
