# CapiUploader

App de escritorio (Electron) para subir capítulos de manga a **Capibara Traductor** con su API v1.

## Uso

```bash
npm install
npm start
```

La primera vez pide la API key (`capi_…`) de tu scan. Puedes registrar **varios scans** (una clave por
scan) y cambiar entre ellos desde el menú con el nombre del scan, arriba a la derecha. Las claves se
guardan **cifradas** con el almacén seguro de Windows (DPAPI, vía `safeStorage`) en
`%APPDATA%\CapiUploader\config.json` y se administran en el botón de la llave («Mis scans»).

Al actualizar desde la 1.0, la clave guardada se convierte sola en el primer scan.

## Secciones

La barra superior tiene tres secciones: **Subir**, **Importar de web** y **Descargar**. Una subida,
importación o descarga sigue en marcha aunque cambies de sección (la pestaña muestra un punto).

### Subir

- **Un capítulo**: arrastra las páginas, marca páginas simples y la destacada, programa y sube.
- **Varios capítulos**: una carpeta por capítulo, de una o varias obras del mismo scan.
  - Soltar `Lote/Obra/Capítulo` reparte los capítulos por obra según el nombre de la carpeta.
  - La programación escalonada lleva una secuencia por obra.

Desde la 1.3 no hay acceso anticipado: Capibara retiró los capítulos de lectura anticipada.

### Importar de web

Trae los capítulos de una obra desde otra web de manga a una obra que **ya existe** en el scan.

1. Se pega el enlace de la obra (la página con la lista de capítulos) y se pulsa **Buscar**.
2. La app reconoce el sitio y sugiere la obra de Capibara por el título. Si la obra no está en el
   scan, pide crear primero su ficha en Capibara.
3. Se marcan los capítulos (por defecto, los que faltan en Capibara); si la web mezcla traducciones,
   se filtran por idioma. En webs como MangaDex, donde varios scans suben el mismo capítulo, se
   filtran también por scan (el que va entre corchetes al final del título); si alguno se parece al
   nombre del scan activo, se elige solo. El número de cada capítulo se puede corregir en su fila.
4. Hay que confirmar que el contenido es del scan. Al importar, las páginas se bajan a
   `%APPDATA%\CapiUploader\import-cache` (se borra a los 3 días) y los capítulos pasan a
   «Varios capítulos» con la obra asignada y la publicación escalonada (por defecto, uno cada 10 minutos).

Los sitios se leen con el motor de [HaruNeko](https://github.com/manga-download/haruneko) (Unlicense),
que conoce más de 800 webs. Las webs que no están en su catálogo pero usan los temas Madara o
MangaStream/Themesia se leen con lectores genéricos. Si un sitio entrega imágenes de relleno en lugar
de las páginas, el capítulo falla con un aviso y no se sube vacío.

**Cloudflare.** Si un sitio pide verificar que eres humano, se abre Chrome, Edge o Brave con un perfil
temporal (no toca el tuyo). Tras marcar la casilla, ese navegador se minimiza y las peticiones a ese
sitio salen de él mientras la app esté abierta; al cerrar la app se cierra. Algunos sitios con una
protección muy estricta no dejan entrar ni así: la app lo avisa. El registro
`%APPDATA%\CapiUploader\scrape.log` anota los pasos de la verificación (nunca valores de cookies).

### Descargar

Baja capítulos de las obras del scan activo con su API key: se elige la obra, los capítulos (todos,
un tramo o sueltos), la carpeta y el formato: JPG (calidad 92, por defecto), PNG o el WEBP original de
Capibara. Cada capítulo queda en `Obra/Vol 3 Cap 12 - Título/001.jpg…`, el
formato que lee «Varios capítulos», y lleva un `.capiuploader.json` para saltarlo si se repite la descarga.

## Archivos de Photoshop (PSD)

Las páginas pueden ser `.psd` o `.psb`, en los dos modos y mezcladas con imágenes normales. Al
agregarlas se convierten a JPG (calidad 92) con [psdc](https://github.com/ChoqueCastroLD/psd-compiler-cli),
que compone todas las capas y vuelve a dibujar el texto con las fuentes instaladas en el equipo.

- Las conversiones se guardan en `%APPDATA%\CapiUploader\psd-cache` (se borran a los 3 días) y se
  reutilizan mientras el PSD no cambie.
- Si falta una fuente, la página se convierte otra vez con el texto que Photoshop guardó en el archivo,
  para que se vea tal como la dejó el editor. Si una capa no tiene ese texto guardado, se dibuja con una
  fuente parecida y la app avisa. Estas conversiones no se reutilizan: al instalar las fuentes y volver a
  agregar el archivo se convierte de nuevo.

`psdc.exe` está en `vendor/psdc/` y se empaqueta con la app. Cómo se compiló y el parche que lleva
están en `vendor/psdc/SOURCE.md`.

## Motor de importación (HaruNeko)

`src/scraper/engine.js` es el motor de sitios de HaruNeko compilado tal cual; `engine.json` dice de qué
commit salió. Para actualizar el catálogo de sitios:

```bash
git clone https://github.com/manga-download/haruneko   # o git pull si ya está
node scripts/build-scraper.mjs <carpeta de haruneko>
```

Solo se reemplazan las piezas de la aplicación de HaruNeko que CapiUploader no usa (ajustes,
almacenamiento, exportadores, idiomas): están en `scripts/scraper/shims/`. `scripts/scraper/entry.ts`
es el puente con la app y `generic.ts` los lectores Madara/MangaStream para webs fuera del catálogo.
El motor corre en una ventana oculta con su propia sesión (`persist:scrape`), separada de la app.

## Generar instalador

```bash
npm run dist   # crea el instalador, el portable y el .zip en dist/
```

## Cómo funciona

1. `POST /uploads` firma URLs para todas las páginas (lotes de 100).
2. Cada imagen se sube con `PUT` directo al almacenamiento (4 en paralelo, con reintentos).
3. `POST /works/:id/chapters` crea el capítulo con las claves en orden de lectura.

Si la creación falla (p. ej. número repetido), las páginas ya subidas se reutilizan durante 45 min al
reintentar. Las peticiones a la API reintentan solas ante `429` (respetando `Retry-After`) y errores `5xx`.

Las API keys viven solo en el proceso principal; la interfaz nunca las ve.

## Pruebas en desarrollo

Sin empaquetar, la variable `CAPI_USER_DATA_DIR` cambia la carpeta de configuración para que las
pruebas no toquen la del usuario, y `CAPI_TUNNEL_TEST=<url>` fuerza el túnel del navegador para ese
sitio (sirve para probar el modo Cloudflare con una web que no lo tiene). La app instalada las ignora.

## Estructura

- `src/main/` — proceso principal: cliente de la API, scans y claves, flujo de subida. `psd.js` convierte los PSD.
  `download.js` es «Descargar»; `scrape.js`, `importer.js` y `cfbridge.js` son «Importar de web»
  (motor, descarga de capítulos y Cloudflare); `images.js` tiene lo común para bajar imágenes.
- `src/preload/` — puente seguro (`window.capi`) entre la UI y el proceso principal.
- `src/renderer/` — interfaz (HTML/CSS/JS sin frameworks). `batch.js` es el modo «Varios capítulos»,
  `import.js` y `download.js` las secciones nuevas y `views.js` cambia entre secciones.
- `src/scraper/` — motor de HaruNeko compilado (Unlicense, ver `HARUNEKO-UNLICENSE`) y su ventana.
- `scripts/` — `build-scraper.mjs` compila el motor.
- `vendor/psdc/` — conversor de PSD (MIT) que se incluye en el instalador.
