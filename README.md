# CapiUploader

App de escritorio (Electron) para subir capítulos de manga a **Capibara Traductor** con su API v1, y también a
**ScanCrimson**, **Mangation** y **MangaDex** (ver «Plataformas»).

## Reglas y restricciones

**Capibara Traductor.** La app sigue, y debe seguir siempre, las reglas que autoriza el creador de
capibaratraductor.com:

- Se usa solo su **API v1 oficial**, con la API key de cada scan y los permisos que esa key tenga
  (`chapters:write`, `works:write`…). La app no usa endpoints internos de la web ni inicia sesión con la
  contraseña de la cuenta web.
- Se respetan los **límites de la API**: la app lee los que manda Capibara (`X-RateLimit-*`), espera antes de
  llegar al tope y se pausa cuando el límite se alcanza, en vez de insistir.
- **No se salta ninguna protección.** Si la web protege sus imágenes, no se intenta obtenerlas por otro
  camino. Las páginas de Capibara solo se leen con la API y la key del scan dueño de la obra («Descargar» e
  importar desde Capibara).
- Si las reglas o la API de Capibara cambian, la app se ajusta a ellas, aunque eso signifique quitar funciones.

**Otras webs y plataformas.** La herramienta puede extenderse a otras webs (ScanCrimson, Mangation y los
sitios de «Importar de web»), siempre con estas condiciones:

- Se usan sus paneles y APIs con la cuenta del propio usuario, con su ritmo de peticiones y sin saltarse
  verificaciones ni protecciones.
- «Importar de web» es para traer **contenido del propio scan**: antes de importar hay que confirmarlo.
- **Si el dueño de una web integrada no está de acuerdo**, la integración con su sitio **se retira**, o se
  ajusta a las condiciones y reglas que ese sitio tenga. Basta con pedirlo abriendo un *issue* en
  [el repositorio](https://github.com/JRickOSanchez/CapiUploader/issues).

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

## Plataformas

Junto al chip del scan, arriba a la derecha, el botón de plataforma cambia entre **Capibara**, **ScanCrimson**,
**Mangation** y **MangaDex**. Cada una tiene sus obras, su lista de «Capítulos subidos», su última obra elegida y su propio
estilo (Crimson: vino casi negro con acento rosa y títulos serif; Mangation: violeta grisáceo con lavanda y
pestañas tipo píldora; MangaDex: gris carbón plano con acento naranja, Poppins sin cursiva y la pestaña activa
en un bloque naranja relleno). Las fuentes de esos temas van incluidas en `src/renderer/assets/fonts` (licencia OFL,
ver `OFL.txt`).

- **Capibara**: API key por scan, como siempre. Tiene todo: tomos, extras, páginas simples, página destacada,
  programar, avisos, «Descargar» y la ventana de importar.
- **ScanCrimson**: se entra con el usuario y la contraseña del panel (admin.scancrimson.com). Se puede
  programar la publicación y elegir si se avisa en Discord; no hay tomos, extras, páginas simples ni página
  destacada, así que el formulario los oculta. Crimson solo acepta páginas **WebP**: la app las convierte sola.
  Crimson limita los capítulos por cuenta («máximo N capítulos cada M minutos»); al llegar al tope, «Varios
  capítulos» se pausa con cuenta atrás y sigue sola. Si una página falla a mitad, el capítulo ya creado se
  recuerda y al reintentar se suben solo las páginas que faltan (sin crear otro).
- **Mangation**: se entra con el correo y la contraseña de creador (creator.mangation.com). Solo número y
  título: no hay programación ni avisos. El capítulo se sube en una sola petición (máximo 200 MB); si la
  conexión se corta, se revisa si llegó antes de dar un error. Cada página va en WebP si pesa menos que el
  original.
- La contraseña nunca se guarda: solo la sesión (el token de Crimson, que dura unos 7 días, o la cookie de
  Mangation), cifrada igual que las API keys. Si vence, la app pide entrar de nuevo.
- **Nueva obra** abre el formulario de cada plataforma: en Crimson título, tipo, estado, sinopsis, géneros de su
  lista, +18, portada y banner (se convierten a WebP a la medida de su panel); en Mangation además la
  demografía, hasta 15 géneros de su lista y la portada obligatoria (hasta 5 MB).
- En «Capítulos subidos», Crimson permite cambiar el número o borrar, y Mangation y MangaDex borrar (no tienen
  papelera: se pide confirmación).

### MangaDex

Se sube con la API oficial (v5) de `api.mangadex.org`, y **solo a obras que ya existen en MangaDex**: crear una
obra allí es un borrador que revisa su staff, así que la app no lo ofrece. El entorno de pruebas
`api.mangadex.dev` no se usa.

- **Cuenta.** Cada usuario entra con su cuenta y el **cliente personal de la API** (Client ID y Client Secret),
  que se crea en mangadex.org → Settings → API Clients y que MangaDex puede tardar en aprobar. La contraseña no
  se guarda: solo el `refresh_token` con el Client ID y el Client Secret, cifrados igual que las API keys. El
  `access_token` dura 15 minutos y se renueva solo, también a mitad de una subida larga. «Cerrar sesión» los
  borra.
- **Cómo se consigue el cliente personal** (según la documentación de MangaDex):
  1. Entrar en mangadex.org con la cuenta y abrir `https://mangadex.org/settings`.
  2. En la sección **API Clients**, pedir un cliente personal siguiendo sus instrucciones.
  3. MangaDex lo aprueba al momento o lo deja **pendiente** hasta que su staff lo apruebe a mano. Mientras esté
     pendiente no se puede usar.
  4. Ya aprobado, se ve su **Client ID** (`personal-client-…`). El **Client Secret** aparece con el botón
     **«Get Secret»**.
  - El Client Secret es como una contraseña: MangaDex nunca lo pide, y solo sirve para la cuenta dueña del
    cliente. Este acceso no pide la verificación en dos pasos de la cuenta.
  - La guía de la versión de prueba explica estos pasos para los usuarios (`src/main/guides/beta-mangadex.md`).
- **Grupos, idioma y reglas.** En la ventana de la cuenta se eligen **todos los grupos** de scanlation que
  trabajan los capítulos (hasta 10, por nombre o pegando su enlace), el idioma de las traducciones (Español
  Latinoamérica por defecto) y se aceptan las [reglas](https://mangadex.org/rules) y los
  [términos de subida](https://mangadex.org/compliance). Sin aceptarlos no se sube nada, porque cada subida los
  acepta en nombre de la cuenta (`termsAccepted`). Las reglas piden que quien no tiene grupo cree uno con su
  nombre de usuario: «Sin grupo» solo aparece si no hay grupos y hay que confirmarlo como autor o traductor
  autorizado.
- **Obras.** La lista trae las obras de los grupos y las que agregues con «Agregar obra» (buscando por título o
  pegando el enlace de la obra). Los capítulos que cuentan como «ya subidos» son los de los grupos (o los de la
  cuenta, sin grupo), y cada uno trae su idioma.
- **Idioma por capítulo.** El de la cuenta es el predeterminado, y cada capítulo puede ir en otro (un grupo que
  traduce a varios idiomas): el campo «Idioma del capítulo (MangaDex)» en «Un capítulo» y una lista en cada fila
  de «Varios capítulos». Solo se ven si la subida va a MangaDex (activa o en «También a…»). El número siguiente,
  los «ya existe», los repetidos de la lista y «Capítulos subidos» se cuentan por idioma, porque en MangaDex el
  12 en español y el 12 en inglés son capítulos distintos.
- **Páginas.** Las reglas de MangaDex aceptan JPG, PNG o GIF de hasta 20 MB y 10 000 × 10 000 px. Las que
  cumplen van tal cual; las demás (WebP, AVIF, muy pesadas o muy grandes) se convierten a JPG con el mismo
  convertidor, y una tira larga (manhwa) se corta en partes de 9000 px de alto. Como máximo 500 imágenes y
  300 MB por capítulo.
- **Reglas que revisa la app.** Con MangaDex como destino (activa o en «También a…»):
  - no se sube sin grupos (o «Sin grupo» confirmado) ni sin aceptar las reglas;
  - un título con descriptores inventados («[HQ]», «v2», «(LQ)»…) no deja subir; solo se permiten
    «Censored/Uncensored»;
  - el tomo no se rellena solo con el del capítulo anterior, porque las reglas piden ponerlo solo si el capítulo
    ya salió en un tomo; sí se toma de una carpeta «Vol N».
- **Recordar las reglas.** Antes de la primera subida a MangaDex de cada sesión aparece un recordatorio con las
  reglas principales. «Ver todas las reglas», el enlace «reglas» de la cuenta y la guía de la beta abren una
  ventana con la traducción completa de mangadex.org/rules (`src/main/guides/mangadex-rules.md`, incluida en
  la app). Si algo no coincide, manda la página de MangaDex.
- **Subida.** MangaDex permite una sola sesión de subida por cuenta. Si hay una abierta que dejó la app, se
  abandona; si es de otro lado (por ejemplo, la web), la app avisa y no la toca. Las páginas se mandan de 10
  en 10 y al final se confirma el capítulo con su número, tomo, título, idioma, orden de páginas y, si se
  programa, la fecha de publicación. Si algo falla antes de confirmar, la sesión se abandona para no dejarla
  ocupada. Si la respuesta de la confirmación se pierde, se revisa si el capítulo quedó creado.
- **Revisión.** El primer capítulo de cada idioma lo revisa el staff de MangaDex (normalmente unas horas, hasta
  48 h). La app lo pregunta antes de subir y lo avisa al terminar.
- **Ritmo.** MangaDex permite unas 5 peticiones por segundo por IP y bloquea la IP si se insiste tras un 429.
  La app va de a 2 peticiones con pausa entre ellas, y un 429 detiene todas las peticiones a MangaDex hasta la
  hora que indica `X-RateLimit-Retry-After`.
- **Sin «Importar de web».** Con MangaDex activa no aparece, y la ventana de importar no deja usarla como
  destino: sus reglas no permiten subir trabajo sacado de otras webs ni de otros grupos. No hay extras,
  páginas simples, página destacada ni avisos.
- En desarrollo (`electron .`), `CAPI_MANGADEX_BASE` y `CAPI_MANGADEX_AUTH` apuntan a un servidor falso; la
  app instalada no los lee.

### Subir también a otras plataformas

El botón **«También a…»** de la barra inferior (opcional) sube cada capítulo a la vez a las plataformas que
marques. La obra equivalente se empareja sola por título (o la eliges una vez y se recuerda).

- Las páginas se leen una sola vez y la conversión a WebP se hace una vez para Crimson y Mangation.
- Capibara empieza a subir mientras se convierten las páginas de las otras.
- Cada plataforma lleva su propio ritmo de peticiones; si una falla, las demás siguen, y al reintentar solo se
  sube a la que faltó.
- En las plataformas secundarias, si el capítulo ya estaba, se omite.
- La barra de avance muestra cómo va cada plataforma.

### Convertidor WebP

Se usa para Crimson y Mangation, y para pasar a JPG las páginas que MangaDex no acepta (a Capibara van siempre
los archivos originales). Usa el códec de
Chromium en una ventana oculta con 1 a 3 hilos, sin librerías nativas, y se cierra solo tras un minuto sin
trabajo. Cada página convertida se guarda en `%APPDATA%\CapiUploader\cache\webp` (se limpia sola a los
3 días), así que los reintentos y las subidas a varias plataformas no la convierten otra vez. Las páginas de más
de 16 383 px por lado (el máximo de WebP) se reducen lo justo; las que ya son WebP no se tocan.

## Secciones

La barra superior tiene dos secciones: **Subir** y **Descargar**. **Importar de web** se abre en su propia
ventana desde «Varios capítulos». Una subida o descarga sigue en marcha aunque cambies de sección (la pestaña
muestra un punto).

### Subir

- **Un capítulo**: arrastra las páginas, marca páginas simples y la destacada, programa y sube.
- **Extras** (arte, ilustraciones, contenido fuera de capítulos): se marcan con «Es un extra» en «Un
  capítulo» o con el selector «Capítulo | Extra» de cada fila en «Varios capítulos». Se muestran como «Extra N» y
  llevan su propia numeración, aparte de los capítulos (la API los guarda como 100000 + N). Las carpetas
  que se llaman «Extra 2», «Especial», «Omake» o «Bonus» se marcan solas, salvo que el nombre traiga
  antes un «Cap N» («Cap 12 - Un día especial» sigue siendo el cap 12). «Numerar desde el último» no
  toca los extras, y «Descargar» los guarda como `Extra N - Título`.
- **Varios capítulos**: una carpeta o un comprimido por capítulo, de una o varias obras del mismo scan
  (ver [Comprimidos](#comprimidos-zip-cbz-rar-cbr-7z)).
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

### Joints

Un joint es una obra que llevan varios scans juntos en Capibara. Los joints donde tu scan es miembro
aparecen en la lista de obras con la etiqueta **Joint**, y se sube a ellos igual que a una obra propia, en «Un
capítulo» o en «Varios capítulos» (`POST /joints/:id/chapters`).

- **Roles.** Debajo de la obra se muestra tu rol. El **líder** y el **uploader** pueden subir. Si tu scan
  **solo puede ver**, la app no deja subir y lo explica; si el servidor lo rechaza igual (`api.joint_viewer`),
  se muestra el mismo mensaje claro.
- **Números.** Los capítulos del joint cuentan como de la obra: el número siguiente se sugiere sobre todos ellos y
  un número que ya está en el joint se marca como repetido. Si otro scan ocupa el número justo mientras subes,
  Capibara deja tu capítulo **en tu ficha** como otra versión (`quedoEnFicha`), y la app avisa quién lo tiene.
- **Versiones y papelera.** El botón «Versiones y papelera» abre cada número con sus versiones (de qué scan es
  cada una y cuál ven los lectores). «Mostrar la mía» pone tu versión como la visible (`versions/show`), y
  «Liberar mi elección» la suelta para que otro scan elija la suya (`versions/release`). Si otro scan ya fijó
  la suya, la app lo dice. La pestaña «Papelera» lista lo borrado del joint (30 días) y permite restaurar.
- Al adivinar la obra por el nombre de una carpeta, si una obra propia y un joint se parecen igual, gana la obra
  propia; el joint se elige con «Cambiar obra».
- «Descargar» no muestra los joints, porque sus capítulos son de varios scans.

### Nueva obra

El botón **«Nueva obra»**, junto a «Elige la obra», crea la ficha de una obra en el scan activo sin entrar
al panel. La clave necesita el permiso `works:write` (si no lo tiene, la app lo avisa).

- Mientras escribes el título busca la obra en el catálogo de Capibara. Si ya existe (otro scan la
  publica), se usa su ficha con «Usar esta ficha» y el tipo, la demografía y los autores salen de ahí;
  Capibara no deja crear otra con el mismo título.
- Para una obra nueva se eligen tipo, demografía y autores (se buscan por nombre; la API no crea autores,
  así que uno que no exista se agrega desde el panel).
- Estado, géneros (los +18 aparecen al marcar «Es +18»), descripción corta, sinopsis, portada y banner.
  La portada y el banner se recortan y escalan solos a 1200×1800 y 2300×650 (las medidas que exige
  Capibara), con una barra para elegir qué parte queda.
- La obra nace **privada**; con «Publicarla al crearla» se publica al terminar, con o sin aviso.
- Al crearla se recargan las obras y queda elegida. En «Importar de web», si la obra de la web no está
  en el scan, «Crear la obra en Capibara» abre el mismo formulario con su título.

### Importar de web

Trae los capítulos de una obra desde otra web de manga a una obra del scan. Se abre en **otra ventana** con el
botón **«Importar de web»** de «Varios capítulos» (o «Importar de otra web» si la lista está vacía). Al terminar,
los capítulos pasan a «Varios capítulos» en la ventana principal para revisarlos, y la ventana de importar se
cierra sola; si algún capítulo falló, queda abierta para ver cuál. Cerrarla a mitad de una importación la
cancela. El tema, el scan activo y las obras nuevas se mantienen al día entre las dos ventanas.

1. Se pega el enlace de la obra (la página con la lista de capítulos) y se pulsa **Buscar**.
2. La app reconoce el sitio y sugiere la obra de Capibara por el título. Si la obra no está en el
   scan, se puede crear ahí mismo con «Crear la obra en Capibara» (ver «Nueva obra»).
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
de las páginas, el capítulo falla con un aviso y no se sube vacío. Si los 3 primeros capítulos fallan con el
mismo error (la web no los está dando), la importación se detiene en vez de pedirle todos los demás.

**Botones de selección.** «Todos», «Los que faltan» y el tramo «Marcar» marcan **una versión por número**: si la
web tiene el mismo capítulo de varios scans, queda la primera (filtra por scan para elegir otra). En las
plataformas sin programación (Mangation) no se ofrece «Programarlos uno cada…».

**Desde Capibara** (para pasar una obra de tu scan a Crimson o Mangation): se pega el enlace de la obra
(`https://capibaratraductor.com/<scan>/manga/<obra>`). La web de Capibara protege sus imágenes, así que se
leen con la API oficial y la API key de ese scan, igual que «Descargar»: solo funciona con obras de los scans
agregados en la app, y la key necesita el permiso `chapters:write`. La key no sale del proceso principal.

**Lectores propios.** Algunas webs de scans en español se leen con lectores de la app
(`src/main/readers/`, un archivo por web), sin el motor: **MangaTV**, **ONF Mangas**, **MangaDex**,
**ShadeManga**, **ZonaTMO**, **Dark Gathering**, **Enchilada Scan** y **Capibara** (con la API). Traen el número, el tomo, el scan
y el idioma de cada capítulo. Si uno falla y HaruNeko conoce la web, se reintenta con él.

- MangaTV cifra la lista de páginas de su lector y mete páginas señuelo que no existen; la app la
  descifra y las salta.
- MangaDex pide que los programas se identifiquen: sus imágenes se piden con un User-Agent propio.
- ONF toma algunas imágenes de MangaDex y da una copia de respaldo, que se usa si la primera falla.
- ZonaTMO: en zonatmo.net (obras en `…/manga/<obra>`) se usa su API JSON, que da la lista completa con número,
  scan e idioma en un par de segundos, y las páginas desde su CDN. zonatmo.org (`…/library/…`) se lee de su HTML.
- ZonaTMO y ONF, si arman la página con JavaScript, se leen en una ventana oculta sin sesión.

**Peticiones a las webs.** Para no cargar a los sitios ni hacerse bloquear:

- Cada web tiene su turno: como mucho 4 peticiones a la vez, y si responde «demasiadas peticiones» (429 o 503
  con `Retry-After`) todas las peticiones a esa web esperan juntas, en vez de insistir cada una por su lado.
- Una página que no existe (404, 403, 410…) no se reintenta. Las fallas pasajeras se reintentan en un solo
  lugar y con espera (como mucho 3 intentos por página); con el motor de HaruNeko, que no reintenta solo, se
  espera 1 s y 2 s entre intentos.
- Volver a buscar la misma obra en los 5 minutos siguientes reutiliza lo ya leído: los lectores propios guardan
  la lista de las últimas 5 obras y el motor libera cada obra 5 minutos después de dejar de usarla. En las
  pruebas, repetir la búsqueda pasó de 5 s a 61 ms con un lector propio y de 20 s a 7 ms con el motor.

**Cloudflare.** Si un sitio pide verificar que eres humano, se abre Chrome, Edge o Brave con un perfil
temporal (no toca el tuyo). Tras marcar la casilla, ese navegador se minimiza y las peticiones a ese
sitio salen de él mientras la app esté abierta; al cerrar la app se cierra. Algunos sitios con una
protección muy estricta no dejan entrar ni así: la app lo avisa. El registro
registro de diagnóstico (ver «Ajustes y memoria») anota los pasos de la verificación, nunca valores de cookies.

### Descargar

Baja capítulos de las obras del scan activo con su API key, que necesita el permiso `chapters:write`
(Capibara solo da las imágenes de las páginas a esas claves). Se elige la obra, los capítulos (todos,
un tramo o sueltos), la carpeta y el formato: JPG (calidad 92, por defecto), PNG o el WEBP original de
Capibara. Cada capítulo queda en `Obra/Vol 3 Cap 12 - Título/001.jpg…`, el
formato que lee «Varios capítulos». Si se repite la descarga, se saltan los capítulos que ya tienen
todas sus páginas en ese formato. En la carpeta solo quedan las imágenes, así que se puede subir tal
cual a un Drive. Las versiones 1.3.0 y 1.3.1 dejaban un `.capiuploader.json`, que se borra al volver a descargar.

**Guardar cada capítulo como** elige entre la carpeta con las páginas (por defecto) o un comprimido por
capítulo: **CBZ** (lo abren los lectores de cómics) o **ZIP**. El comprimido queda como
`Obra/Vol 3 Cap 12 - Título.cbz`, con las páginas en la raíz y sin volver a comprimirlas (ya vienen comprimidas), y
la carpeta de trabajo se borra al terminar. Si ya había una carpeta completa de una descarga anterior, se
empaqueta sin volver a bajar nada y la carpeta se deja como estaba. Al repetir la descarga se saltan los
comprimidos que ya tienen todas las páginas en ese formato. «Varios capítulos» acepta esos comprimidos para
volver a subirlos. Lo escribe `src/main/zip.js`, sin dependencias.

## Ajustes, diagnóstico y novedades

El fondo de la app lleva una cuadrícula tenue, como la web de Capibara (`css/base.css`).

El botón de ajustes de la barra superior tiene la **aceleración gráfica**: usa la tarjeta de video para dibujar
la ventana. Apagada, la app arranca con unos 150 MB de memoria en lugar de unos 240, pero las animaciones y las
listas largas de páginas pueden ir menos fluidas en equipos lentos. Electron solo deja cambiarla al arrancar:
el cambio se aplica con «Reiniciar ahora» (que espera a que no haya una subida, descarga o importación en curso).

**Diagnóstico.** «Ajustes → Ver registro» muestra lo que hizo la app y lo que falló: cada petición a la API
(método, ruta, estado y tiempo), las esperas por límites, los errores de cualquier sección, los del motor y los
de la propia interfaz. «Copiar para soporte» copia el registro con un resumen del equipo (versiones, aceleración
gráfica, trabajos en curso). Nunca guarda API keys, tokens, cookies ni firmas de URLs: se tapan antes de
anotarse. En memoria quedan las últimas 500 entradas; en disco, `%APPDATA%\CapiUploader\logs\capiuploader.log`
se escribe en tandas y, al pasar de 1 MB, pasa a `capiuploader.old.log`.

**Novedades.** Después de actualizar, se abre una ventana aparte con las notas del release de la versión nueva
(solo una vez, y no en la primera instalación). También se abre desde «Ajustes → Ver novedades». Las notas se
leen de GitHub y se muestran sin las secciones de descarga e instalación; sin conexión, la ventana ofrece abrir
la página del release.

El motor de HaruNeko (unos 55-70 MB) solo arranca al usar «Importar de web» con una web sin lector propio, y se
cierra solo tras 10 minutos sin uso. Vuelve a arrancar en cuanto se lo necesita; si había una obra abierta, se
vuelve a abrir sola al importar (cada capítulo se busca por su id, por si la web cambió el orden).

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

## Comprimidos (ZIP, CBZ, RAR, CBR, 7Z…)

En los dos modos se pueden agregar comprimidos en lugar de carpetas: `.zip`, `.cbz`, `.rar`, `.cbr` (RAR4 y
RAR5), `.7z`, `.cb7`, `.tar`, `.cbt` y tar comprimidos (`.tar.gz`, `.tgz`, `.tar.bz2`, `.tar.xz`…).

- **Un capítulo**: todas las imágenes del comprimido, primero las sueltas y después las de cada carpeta, en
  orden natural.
- **Varios capítulos**: un comprimido con las imágenes sueltas (o en una sola carpeta) es un capítulo y se
  llama como el archivo (`Cap 12.cbz` → «Cap 12»). Si trae varias carpetas, cada una es un capítulo y el
  nombre del archivo cuenta como la carpeta de la obra (`Choujin X.zip/Cap 1`). Una carpeta llena de
  comprimidos (`Choujin X/Cap 1.cbz`, `Cap 2.cbz`…) funciona igual que una de carpetas. «Seleccionar
  comprimidos» y el botón «Comprimidos» los eligen (Windows no deja elegir carpetas y archivos a la vez);
  arrastrarlos funciona con todo.
- Solo se extraen imágenes y PSD (se ignoran `__MACOSX` y los `._` de macOS) a
  `%APPDATA%CapiUploaderarchive-cache`, que se reutiliza mientras el archivo no cambie y se borra a los 3
  días. La extracción corre en un hilo aparte, así que la ventana no se congela, y se ve su avance.
- Antes de extraer se revisa la lista: un comprimido **con contraseña**, **dañado o incompleto**, **sin
  imágenes**, con más de 5000 imágenes o de más de 8 GB descomprimido se rechaza con un aviso claro, y los demás
  se agregan igual.

Se usa [7-Zip](https://www.7-zip.org/) compilado a WebAssembly ([7z-wasm](https://github.com/use-strict/7z-wasm)),
licencia GNU LGPL con la restricción de unRAR: **el código de RAR solo se usa para descomprimir y no puede
usarse para desarrollar un compresor compatible con RAR (WinRAR)**. Las licencias van en
`node_modules/7z-wasm/License.txt` y `unRarLicense.txt`, dentro del instalador.

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
npm run dist   # revisa y prueba el código, y crea el instalador, el portable y el .zip en dist/ (nunca publica nada)
npm run icons  # vuelve a generar build/icon.png, build/icon.ico y el de la ventana desde build/icon.svg
npm run installer-art  # vuelve a generar las imágenes del instalador (con PREVIEW=carpeta, también una vista previa)
```

El instalador es un asistente en español con imágenes propias (`build/installerSidebar.bmp`,
`uninstallerSidebar.bmp` e `installerHeader.bmp`, generadas desde `build/icon.svg` con `npm run installer-art`)
y textos propios en `build/installer.nsh` (que debe guardarse en UTF-8 con BOM). Al desinstalar no se borran los
scans ni los ajustes.

Antes de empaquetar, `npm run dist` corre `npm run check` (sintaxis de todos los scripts) y `npm test`: si
algo falla, no se crea el instalador. La app no tiene módulos nativos, así que la compilación se salta la
recompilación de dependencias (`npmRebuild: false`). Las pruebas (`test/`) no entran en el instalador.

El ícono sale de `build/icon.svg`; para 16–32 px se usa `build/icon-small.svg`, más simple.

## Actualizaciones

La app busca una versión nueva en los releases de GitHub (`JRickOSanchez/CapiUploader`) al abrirse y
cada 6 horas. Si la hay, aparece un botón en la barra superior.

- **Instalada con el Setup**: la baja sola en segundo plano y la instala al cerrar el programa, o al
  pulsar «Reiniciar y actualizar». Para eso el release debe traer **`latest.yml`** y el
  `CapiUploader-Setup-x.y.z.exe` (con su `.blockmap`) tal como salen de `dist/`. Si falta `latest.yml`,
  avisa y ofrece descargar el instalador.
- **Portable o .zip**: avisa y abre la descarga del archivo nuevo, que reemplaza al anterior.

Los scans y ajustes se conservan en todos los casos (`%APPDATA%\CapiUploader`). La app no está firmada, así
que no se comprueba el editor del instalador; sí su sha512, que viene en `latest.yml`.

### Versiones de prueba (beta)

Antes de una versión grande se publica una de prueba, por ejemplo `1.5.0-beta.1`, para que algunos scans la
usen y reporten fallas.

- **Se publica como «pre-release» en GitHub**, nunca como «latest». Así quien tiene una versión final no la
  recibe: la app solo mira el último release final (`/releases/latest`).
- Quien instala una beta sí ve las versiones de prueba: pasa sola a la siguiente beta y, al salir la final, a
  la final (`1.5.0` es más nueva que `1.5.0-beta.3`).
- La beta también trae **`latest.yml`**, y hay que subirlo al release junto con el instalador y su `.blockmap`. No
  afecta a las versiones finales, porque GitHub nunca da un pre-release como «latest». El actualizador de una
  beta busca primero `beta.yml` y, si no está, usa `latest.yml`.
- **Guía al abrir.** Con una versión de prueba instalada, cada vez que arranca la app se abre una ventana aparte
  con la guía de lo que se prueba (`src/main/guides/beta-mangadex.md`, incluida en la app, así que se ve sin
  conexión): cómo debería funcionar la subida a MangaDex paso a paso, qué no se debe subir, qué significan los
  errores y cómo reportar una falla. También se abre desde Ajustes → «Ver guía». Con una versión final no aparece.
- Para volver a la versión final antes de que salga la siguiente, se instala encima el Setup de la última final.
  Los scans y ajustes se conservan.
- Las fallas se reportan en [Issues](https://github.com/JRickOSanchez/CapiUploader/issues/new/choose) con el
  formulario «Reportar una falla» (`.github/ISSUE_TEMPLATE/falla.yml`): versión, plataforma, pasos, mensaje y el
  registro de Ajustes → Diagnóstico → «Copiar para soporte», que ya tapa contraseñas, API keys, el Client
  Secret de MangaDex y los tokens. La versión instalada se ve en Ajustes, junto a «Novedades».

## Cómo funciona

1. `POST /uploads` firma URLs para todas las páginas (lotes de 100).
2. Cada imagen se sube con `PUT` directo al almacenamiento (4 en paralelo, con reintentos).
3. `POST /works/:id/chapters` crea el capítulo con las claves en orden de lectura (en un joint,
   `POST /joints/:id/chapters`).

Si la creación falla (p. ej. número repetido), las páginas ya subidas se reutilizan durante 45 min al
reintentar. Pasado ese plazo se olvidan solas (se revisa cada 5 min), y al terminar una tanda de «Varios
capítulos» solo se guardan las de los capítulos que quedaron en la cola (fallidos o cancelados).

Para gastar pocas peticiones y fallar menos:

- **Ritmo por clave.** Cada respuesta trae cuántas peticiones le quedan a la clave en el minuto
  (`X-RateLimit-Remaining`/`Reset`). Si quedan 3 o menos, la app espera a que se reinicie el minuto en vez de
  chocar con el límite; esas 3 quedan libres para otros bots o paneles que usen la misma clave.
- **Lecturas compartidas.** Dos lecturas iguales al mismo tiempo (p. ej. la lista de capítulos de una obra pedida
  desde dos secciones) hacen una sola petición.
- **Reintentos.** Ante errores `5xx` y de red se reintenta con esperas crecientes y algo de azar (para no salir
  todos a la vez), respetando el `Retry-After` si lo hay. Un `429` con una espera corta (hasta 60 s) se reintenta
  solo; uno largo (límites por hora o por día) devuelve el error con `retryAfter`, y «Varios capítulos» se pausa
  hasta entonces.
- **Capítulos que sí llegaron.** Si un intento de crear el capítulo se corta y el reintento responde que ya
  existe, es que el primero llegó: se busca y se da por subido, en vez de mostrar un error falso.

Los errores muestran el código de rastreo (`traceId`) de Capibara para mandarlo a soporte.

Las API keys viven solo en el proceso principal; la interfaz nunca las ve.

## Pruebas en desarrollo

```bash
npm run check  # sintaxis de todos los scripts, sin ejecutarlos
npm test       # pruebas de test/ con node:test (sin red ni Electron)
```

Las pruebas cubren lo que no necesita la ventana: Crimson y Mangation contra servidores falsos (multipart,
límites, capítulos a medias, subidas cortadas que sí llegaron, cookie renovada), el avance de la subida a varias, el cliente de la API (paginación, errores, reintentos),
la descarga de imágenes, la detección de capítulos en carpetas, el cuerpo de la subida, los lectores propios
(con páginas de ejemplo, incluido el lector cifrado de MangaTV), la validación de obras nuevas y la detección
de número y obra por el nombre de las carpetas (`src/renderer/js/names.js`, cargado en un contexto aparte).

Sin empaquetar, la variable `CAPI_USER_DATA_DIR` cambia la carpeta de configuración para que las
pruebas no toquen la del usuario, y `CAPI_TUNNEL_TEST=<url>` fuerza el túnel del navegador para ese
sitio (sirve para probar el modo Cloudflare con una web que no lo tiene). `CAPI_UPDATE_TEST=1.3.0` hace
como si la app fuera esa versión del .zip, para probar el aviso de actualización contra los releases
reales, `CAPI_ENGINE_IDLE_MS=20000` cierra el motor de importación tras 20 s sin uso (en vez de 10 min), y
`CAPI_WHATSNEW_TEST=1` abre la ventana de novedades al arrancar. `CAPI_CRIMSON_BASE` y `CAPI_MANGATION_BASE`
apuntan esas plataformas a un servidor de pruebas.
La app instalada las ignora.

## Estructura

- `src/main/` — proceso principal (CommonJS, sin frameworks):
  - `main.js` arranca la app; `window.js` es la ventana principal.
  - `ipc/` registra los canales que usa la interfaz, por tema: `core.js` (respuesta `{ ok, data }`, clave
    del scan activo y trabajos de uno en uno), `profiles.js` (Mis scans), `system.js` (tema, enlaces,
    actualizaciones), `capibara.js` (obras, capítulos, arreglos y obras nuevas), `files.js` y `transfers.js`
    (subir, descargar e importar) y `platforms.js` (plataforma activa, sesiones, obras y capítulos de
    Crimson y Mangation).
  - `platforms/`: `index.js` (lo que permite cada plataforma y la subida a varias), `http.js` (peticiones con
    ritmo por plataforma, reintentos y multipart leído del disco), `crimson.js`, `mangation.js` y `mangadex.js` (cliente y
    sesión de cada una). `webp.js` es el convertidor (con `renderer/converter.html` y
    `preload/converter.js`).
  - Lógica sin Electron, probada en `test/`: `api.js` (cliente de la API), `upload.js` (subida de un
    capítulo), `files.js` (archivos y carpetas), `works.js` (obras nuevas), `download.js` («Descargar») y `zip.js` (los CBZ/ZIP que guarda),
    `images.js` (bajar y nombrar imágenes) y `util.js` (esperas, paralelo, tareas, cachés).
  - «Importar de web»: `importer.js` (descarga de capítulos), `scrape.js` y `cfbridge.js` (motor de HaruNeko
    y Cloudflare) y `readers/` (lectores propios: `index.js` los une, `http.js` y `html.js` son comunes y
    `sites/` tiene un archivo por web con la misma forma: `match`, `headers`, `list`, `pages`).
  - `store.js` guarda ajustes y claves cifradas; `psd.js` convierte los PSD; `archives.js` abre los
    comprimidos con 7-Zip; `joints.js` lee y sube a los joints; `updater.js` actualiza la app.
  - `diagnostics.js` es el registro de diagnóstico (y `ipc/diagnostics.js` sus canales); `whatsnew.js` la
    ventana de novedades y `markdown.js` convierte las notas de los releases a HTML seguro.
- `src/preload/` — puentes seguros entre la interfaz y el proceso principal: `preload.js` (`window.capi`) y
  `whatsnew.js` (`window.novedades`, solo para la ventana de novedades).
- `src/renderer/` — interfaz (HTML, CSS y JS sin frameworks).
  - `js/` se carga en este orden: `core.js` (utilidades, estado, tema, avisos, preguntas y los eventos
    `on`/`emit` entre secciones), `platforms.js` (plataforma activa y cuentas), `scans.js`, `works.js`, `names.js`, `picker.js`, `single.js` (Un
    capítulo), `batch.js`, `uploaded.js` y `batch-upload.js` (Varios capítulos), `joints.js` (barra y ventana de los joints),
    `download.js`, `import.js`, `newwork.js`, `newwork-alt.js` (obra nueva en Crimson y Mangation), `also.js` («También a…»), `mangadex.js` (cuenta y obras de MangaDex),
    `update.js`, `settings.js` (Ajustes), `diagnostics.js`, `views.js` y `boot.js`, que inicia todo al final.
  - `whatsnew.html` con `js/whatsnew-window.js` y `css/whatsnew.css` es la ventana de novedades, aparte de la
    principal.
  - `css/` en el orden de la cascada: base, componentes, subir, el estilo Capibara, Mis scans, grupos,
    secciones, capítulos subidos, joints, obra nueva, diagnóstico, plataformas y los temas de Crimson y Mangation.
- `src/scraper/` — motor de HaruNeko compilado (Unlicense, ver `HARUNEKO-UNLICENSE`) y su ventana.
- `scripts/` — `build-scraper.mjs` compila el motor, `build-icon.cjs` genera los íconos,
  `build-installer-art.cjs` las imágenes del instalador y `check.cjs` revisa la sintaxis.
- `build/` — íconos, imágenes del instalador e `installer.nsh` (páginas y textos del asistente).
- `test/` — pruebas con `node:test`.
- `vendor/psdc/` — conversor de PSD (MIT) que se incluye en el instalador.
- `node_modules/7z-wasm/` — 7-Zip para los comprimidos (LGPL + restricción de unRAR); va fuera del `.asar`
  (`asarUnpack`) porque lo carga un hilo aparte.
