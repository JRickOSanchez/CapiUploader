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
- **Extras** (arte, ilustraciones, contenido fuera de capítulos): se marcan con «Es un extra» en «Un
  capítulo» o con el selector «Capítulo | Extra» de cada fila en «Varios capítulos». Se muestran como «Extra N» y
  llevan su propia numeración, aparte de los capítulos (la API los guarda como 100000 + N). Las carpetas
  que se llaman «Extra 2», «Especial», «Omake» o «Bonus» se marcan solas, salvo que el nombre traiga
  antes un «Cap N» («Cap 12 - Un día especial» sigue siendo el cap 12). «Numerar desde el último» no
  toca los extras, y «Descargar» los guarda como `Extra N - Título`.
- **Varios capítulos**: una carpeta por capítulo, de una o varias obras del mismo scan.
  - La obra se detecta por el nombre de la carpeta que contiene los capítulos. Por ejemplo, elegir
    `Choujin X` con `Cap 1`, `Cap 2`… dentro los asigna a esa obra. También funciona con
    `Lote/Obra/Capítulo` (reparte por obra) y con `Obra/Vol 2/Capítulo`, que además pone el tomo 2.
    Se ignora lo que va entre corchetes o paréntesis («Choujin X [Scan]») y se compara también con
    el título alternativo. Si la carpeta no lo dice, se usa el nombre del capítulo («Choujin X Cap 12»).
  - Cada fila tiene «Cambiar obra» (mueve solo ese capítulo) y «Ver páginas» (ordenar, quitar, marcar
    simples o la destacada). «Cambiar obra de todos», en el encabezado, mueve el grupo entero.
  - La programación escalonada lleva una secuencia por obra.
  - Si agregas capítulos cuyo número ya está publicado en su obra (por ejemplo, al retomar una
    subida que dejaste a medias), pregunta si omitirlos. También compara la cantidad de páginas.
  - «Numerar desde el último» y «Renumerar en orden desde» piden confirmación antes de cambiar un
    número que viene del nombre de la carpeta. Si al subir algún número no coincide con su carpeta,
    se muestra un resumen antes de empezar.
  - Cada capítulo que termina de subirse sale de la cola y pasa a **Capítulos subidos**. Esa lista se
    guarda por scan, aunque cierres el programa, hasta que la vacíes.
  - El botón «⋯» de cada fila de «Capítulos subidos» sirve para **cambiar el número**, **publicar ya**
    uno programado o **mandarlo a la papelera**. Desde la papelera se puede restaurar (30 días) o volver
    a poner su carpeta en la cola. Nada de esto avisa a nadie, salvo «Publicar y avisar».
  - Si Capibara frena el lote por un límite por hora (por ejemplo, 300 capítulos por hora por scan), la
    subida se pausa con una cuenta atrás y sigue sola con el mismo capítulo.

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

Baja capítulos de las obras del scan activo con su API key, que necesita el permiso `chapters:write`
(Capibara solo da las imágenes de las páginas a esas claves). Se elige la obra, los capítulos (todos,
un tramo o sueltos), la carpeta y el formato: JPG (calidad 92, por defecto), PNG o el WEBP original de
Capibara. Cada capítulo queda en `Obra/Vol 3 Cap 12 - Título/001.jpg…`, el
formato que lee «Varios capítulos». Si se repite la descarga, se saltan los capítulos que ya tienen
todas sus páginas en ese formato. En la carpeta solo quedan las imágenes, así que se puede subir tal
cual a un Drive. Las versiones 1.3.0 y 1.3.1 dejaban un `.capiuploader.json`, que se borra al volver a descargar.

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
npm run dist   # crea el instalador, el portable y el .zip en dist/ (nunca publica nada)
npm run icons  # vuelve a generar build/icon.png, build/icon.ico y el de la ventana desde build/icon.svg
```

El ícono sale de `build/icon.svg`; para 16–32 px se usa `build/icon-small.svg`, más simple.

## Actualizaciones

La app busca una versión nueva en los releases de GitHub (`JRickOSanchez/CapiUploader`) al abrirse y
cada 6 horas. Si la hay, aparece un botón en la barra superior.

- **Instalada con el Setup**: la baja sola en segundo plano y la instala al cerrar el programa, o al
  pulsar «Reiniciar y actualizar». Para eso el release debe traer **`latest.yml`** y el
  `CapiUploader-Setup-x.y.z.exe` (con su `.blockmap`) tal como salen de `dist/`. Si falta `latest.yml`,
  avisa y ofrece descargar el instalador.
- **Portable o .zip**: avisa y abre la descarga del archivo nuevo, que reemplaza al anterior.

Los scans y ajustes se conservan en todos los casos (`%APPDATA%CapiUploader`). La app no está firmada, así
que no se comprueba el editor del instalador; sí su sha512, que viene en `latest.yml`.

## Cómo funciona

1. `POST /uploads` firma URLs para todas las páginas (lotes de 100).
2. Cada imagen se sube con `PUT` directo al almacenamiento (4 en paralelo, con reintentos).
3. `POST /works/:id/chapters` crea el capítulo con las claves en orden de lectura.

Si la creación falla (p. ej. número repetido), las páginas ya subidas se reutilizan durante 45 min al
reintentar. Las peticiones a la API reintentan solas ante errores `5xx` y ante un `429` con una espera
corta (hasta 60 s de `Retry-After`). Uno con una espera larga (límites por hora o por día) devuelve el
error con `retryAfter`, y «Varios capítulos» se pausa hasta entonces. Los errores muestran el código de
rastreo (`traceId`) de Capibara para mandarlo a soporte.

Las API keys viven solo en el proceso principal; la interfaz nunca las ve.

## Pruebas en desarrollo

Sin empaquetar, la variable `CAPI_USER_DATA_DIR` cambia la carpeta de configuración para que las
pruebas no toquen la del usuario, y `CAPI_TUNNEL_TEST=<url>` fuerza el túnel del navegador para ese
sitio (sirve para probar el modo Cloudflare con una web que no lo tiene). `CAPI_UPDATE_TEST=1.3.0` hace
como si la app fuera esa versión del .zip, para probar el aviso de actualización contra los releases
reales. La app instalada las ignora.

## Estructura

- `src/main/` — proceso principal: cliente de la API, scans y claves, flujo de subida. `psd.js` convierte los PSD.
  `download.js` es «Descargar»; `scrape.js`, `importer.js` y `cfbridge.js` son «Importar de web»
  (motor, descarga de capítulos y Cloudflare); `images.js` tiene lo común para bajar imágenes y
  `updater.js` busca e instala actualizaciones.
- `src/preload/` — puente seguro (`window.capi`) entre la UI y el proceso principal.
- `src/renderer/` — interfaz (HTML/CSS/JS sin frameworks). `batch.js` es el modo «Varios capítulos»,
  `import.js` y `download.js` las secciones nuevas, `views.js` cambia entre secciones y `update.js` es el
  aviso de actualización.
- `src/scraper/` — motor de HaruNeko compilado (Unlicense, ver `HARUNEKO-UNLICENSE`) y su ventana.
- `scripts/` — `build-scraper.mjs` compila el motor y `build-icon.cjs` genera los íconos.
- `vendor/psdc/` — conversor de PSD (MIT) que se incluye en el instalador.
