> ⚠️ **Estás usando una versión de prueba.** Esta guía se abre cada vez que la inicias, para que sepas cómo debería funcionar la subida a MangaDex y puedas avisar si algo no hace lo que dice aquí.

## Antes de empezar

Para subir desde la app necesitas tres cosas de MangaDex:
- tu **cuenta**, con su usuario y su contraseña;
- el **Client ID** y el **Client Secret** del **cliente personal de la API** de esa cuenta.

El cliente personal es el permiso que MangaDex da a tu cuenta para usar su API desde un programa como CapiUploader. Se pide una sola vez.

### Qué necesitas

- Una **cuenta de MangaDex** en buen estado, que no esté restringida. Si no tienes, créala en mangadex.org.
- Saber tu **usuario** y tu **contraseña** de MangaDex.

### Cómo conseguir el Client ID y el Client Secret

1. Entra en **mangadex.org** con tu cuenta. Tienes que tener la sesión iniciada.
2. Abre **Settings**, la configuración de tu cuenta: `https://mangadex.org/settings`.
3. Busca la sección **API Clients**, la de los clientes de la API.
4. Pide un **cliente personal** («personal client») siguiendo las instrucciones de esa sección. Si te pide un nombre o una descripción, pon algo que te sirva para reconocerlo, por ejemplo «CapiUploader».
5. Revisa en qué **estado** quedó el cliente:
   - **Aprobado:** ya lo puedes usar. MangaDex a veces lo aprueba al momento.
   - **Pendiente** o **solicitado** (*pending* o *requested*): el staff de MangaDex lo tiene que **aprobar a mano**. Mientras tanto **no se puede usar**, y la app te dirá que el cliente no es válido o aún no está aprobado. MangaDex no da un plazo: espera y vuelve a revisar la sección.
6. Con el cliente aprobado, MangaDex muestra su **Client ID**. Empieza con `personal-client-` y sigue con letras y números. Cópialo **completo**.
7. Pulsa el botón **«Get Secret»** para ver el **Client Secret** y cópialo también.
8. Pega los dos en la app, en «Tu cuenta de MangaDex» (paso 1, más abajo).

### Cuida tu Client Secret

- **El Client Secret es como una contraseña.** No se lo des a nadie. **El staff de MangaDex nunca te lo va a pedir**, y nosotros tampoco.
- No lo pegues en reportes de fallas, capturas, Discord ni chats. El registro de «Copiar para soporte» ya lo tapa.
- Solo **tu cuenta** puede usar tu cliente personal. Cada persona que use la app necesita el suyo.
- Al entrar con un cliente personal, MangaDex **no pide la verificación en dos pasos** de tu cuenta. Por eso es tan importante que el Client Secret y tu contraseña no salgan de ti.
- La app lo guarda **cifrado** en este equipo, y **«Cerrar sesión»** lo borra. Si crees que alguien lo vio, cierra sesión en la app y revisa tu cliente en la sección API Clients de MangaDex.

## 1. Entrar a MangaDex

1. Arriba a la derecha, en el botón de plataforma, elige **MangaDex**. La app cambia a su estilo, gris con naranja.
2. Se abre **«Tu cuenta de MangaDex»**. Escribe tu **usuario**, tu **contraseña**, el **Client ID** y el **Client Secret**, y pulsa **Iniciar sesión**.
3. Si todo está bien, verás «Sesión iniciada como …» y la ventana se queda abierta para el paso siguiente.

**Qué se guarda:** solo la sesión y el cliente de la API, cifrados en este equipo. **La contraseña no se guarda.** La sesión se renueva sola cada 15 minutos, también a mitad de una subida larga. «Cerrar sesión» lo borra todo.

## 2. Grupos, idioma y reglas

En la misma ventana de la cuenta:

- **Grupos de scanlation:** busca cada grupo por su nombre o pega su enlace de MangaDex, y elígelo. Las reglas piden marcar **todos los grupos que trabajaron** el capítulo, así que agrega todos con los que trabajas (hasta 10). Para quitar uno, usa la ✕ junto a su nombre.
- **Si no tienes grupo**, crea en MangaDex un grupo con **tu nombre de usuario** y elígelo aquí.
- **«Sin grupo»** solo aparece si no hay ningún grupo elegido, y solo debes marcarlo si eres **el autor** de la obra o **un traductor autorizado** por él.
- **Idioma predeterminado de tus traducciones:** Español (Latinoamérica) por defecto. Es el que viene elegido en cada capítulo; si tu grupo traduce a varios idiomas, cada capítulo puede ir en otro (ver «4. Agregar el capítulo»).
- **Reglas:** marca la casilla de que leíste y aceptas las **reglas** y los **términos de subida** de MangaDex. Sin esa casilla la app no sube nada, porque cada subida le dice a MangaDex que tu cuenta los acepta. El enlace «reglas» abre la **traducción completa** dentro de la app.

Pulsa **Guardar**. Puedes volver a esta ventana cuando quieras desde el chip de tu cuenta, arriba a la derecha.

## 3. Elegir la obra

- En **«Elige la obra»** aparecen solas las obras de **tus grupos**.
- Si la obra no está en la lista, usa **«Agregar obra»**: búscala por título o pega su enlace (`https://mangadex.org/title/…`). Queda guardada en tu lista.
- **Solo se puede subir a obras que ya existen en MangaDex.** La app no crea obras nuevas allí.
- Debajo de la obra ves el último capítulo y cuántos hay. Solo cuentan los de **tus grupos** (o los de tu cuenta, sin grupo) **en el idioma elegido para el capítulo**.

## 4. Agregar el capítulo

- **Un capítulo:** arrastra las páginas, una carpeta o un comprimido (ZIP, CBZ, RAR, CBR, 7Z…). Revisa el orden.
- **Varios capítulos:** arrastra varias carpetas o comprimidos. El número se toma del nombre («Cap 12», «013», «Vol 2 Cap 15 - Título»…).
- Pon el **número**, y si hace falta el **tomo**, el **título** y una **fecha de publicación** (programar).
- **Tomo:** solo si el capítulo **ya salió publicado en un tomo**. Con MangaDex la app no lo rellena sola con el del capítulo anterior, porque las reglas piden no adivinarlo. En obras por **temporadas**, la temporada va como tomo.
- **Título:** si el capítulo no tiene título, déjalo vacío. No agregues «[HQ]», «v2» ni otros descriptores; la app no deja subir si los encuentra. Solo se permiten «Censored» o «Uncensored».
- **Partes:** no juntes varios capítulos en uno, y pártelo solo si la obra original también viene partida. Usa decimales (12.5) para partes y extras.
- **Idioma de cada capítulo:** en «Un capítulo» está el campo **«Idioma del capítulo (MangaDex)»**, y en «Varios capítulos» cada fila tiene el suyo (ES-LA, ES, EN, PT-BR). Viene elegido el de tu cuenta; cámbialo si ese capítulo es de otra traducción. En MangaDex **el 12 en español y el 12 en inglés son capítulos distintos**: el número siguiente, los «ya existe» y los repetidos se revisan **por idioma**.
- MangaDex **no tiene extras** ni páginas simples o destacada, así que esas opciones no aparecen.

**Las páginas se ajustan solas a lo que acepta MangaDex**, que pide JPG, PNG o GIF de hasta 20 MB y 10 000 × 10 000 px:

- Las que ya cumplen van **tal cual**.
- Las WebP, AVIF o demasiado pesadas o grandes se **pasan a JPG**.
- Las **tiras largas** (manhwa) se **cortan en partes** de 9000 px de alto, así que el capítulo puede quedar con más páginas que las que agregaste. Es normal.
- Como máximo **500 imágenes y 300 MB por capítulo**. Si se pasa, la app te lo dice antes de empezar.
- **No unas páginas de libro en una tira larga.** Las páginas dobles sí van juntas, en una sola imagen.

## 5. Subir

Al pulsar **Subir**, la primera vez cada vez que abres la app aparece un **recordatorio de las reglas** de MangaDex: «Entendido, subir» sigue, y «Ver todas las reglas» abre la traducción completa.

Después, la app:

1. Revisa si este capítulo pasará por la **revisión del staff** de MangaDex.
2. Abre una **sesión de subida**. MangaDex permite **una sola por cuenta**: no subas desde la web al mismo tiempo.
3. Prepara las páginas (verás «Convirtiendo» si alguna pasa a JPG).
4. Las sube **de 10 en 10**.
5. Confirma el capítulo con su número, tomo, título, idioma y orden de páginas.

**El primer capítulo de cada idioma** en una obra lo revisa el staff de MangaDex antes de mostrarlo. Suele tardar unas horas, a veces hasta 48 h. La app te avisa con «MangaDex lo revisará». No es un error.

La app va **despacio a propósito**. MangaDex bloquea la conexión si se le hacen demasiadas peticiones, así que si pide esperar, la app se pausa sola y sigue.

## 6. Después de subir

- El capítulo pasa a **«Capítulos subidos»**. Desde ahí puedes abrirlo en MangaDex o **borrarlo**. MangaDex no tiene papelera en la app, así que se pide confirmación.
- **«También a…»** puede subir el mismo capítulo a la vez a MangaDex y a otra plataforma (Capibara, ScanCrimson o Mangation).

## Lo que no se debe hacer

- **No subas capítulos de prueba** a MangaDex. Prueba con capítulos reales de tu grupo.
- No marques **«Sin grupo»** si no eres el autor o un traductor autorizado, y no te hagas pasar por staff de MangaDex.
- No subas trabajo de **otros grupos**, lanzamientos **oficiales** ni capítulos sacados de **agregadores**. Por eso, con MangaDex activa no aparece **«Importar de web»**.
- Subir algo que va contra sus reglas puede terminar en la **restricción o el baneo** de tu cuenta de MangaDex.

## Reglas de MangaDex

Las reglas completas, traducidas, se abren desde el enlace **«reglas»** de tu cuenta de MangaDex o desde **«Ver todas las reglas»** en el recordatorio antes de subir. Lo más importante para subir capítulos:

- Hasta **500 imágenes y 300 MB** por capítulo; cada imagen hasta **20 MB** y **10 000 × 10 000 px**.
- Un capítulo por subida. Pártelo solo si la obra original viene partida, y usa decimales.
- **Todos los grupos** que trabajaron. Sin grupo propio: crea uno con tu nombre de usuario.
- **Sin título inventado** ni descriptores («[HQ]», «v2»). Tomo solo si ya salió en uno.
- No unas páginas de libro en una tira larga. Las páginas dobles, en una sola imagen.

## Si algo falla

| Mensaje | Qué significa |
|---|---|
| «El Client ID o el Client Secret no son válidos, o el cliente aún no está aprobado» | Revisa los datos del cliente o espera a que MangaDex lo apruebe. |
| «Usuario o contraseña incorrectos» | Los datos de tu cuenta de MangaDex no son correctos. |
| «Tienes una subida abierta en MangaDex» | Hay una subida a medias en la web. Termínala o cancélala allí. |
| «Antes de subir, acepta las reglas…» | Falta marcar la casilla de reglas en tu cuenta. |
| «Elige en tu cuenta los grupos que trabajaron el capítulo» | No hay grupos elegidos ni «Sin grupo» confirmado. |
| «Quita «[HQ]» del título…» | El título lleva un descriptor que las reglas no permiten. |
| «MangaDex acepta hasta 300 MB por capítulo» | El capítulo pesa demasiado. Reduce el peso de las páginas. |
| «MangaDex pide esperar…» | Se llegó a su límite de peticiones. La app sigue sola cuando se libera. |

**Para reportar una falla:**

1. Abre **Ajustes → Diagnóstico → «Copiar para soporte»**. El registro ya tapa contraseñas, el Client Secret, las API keys y los tokens.
2. Entra en [Reportar una falla](https://github.com/JRickOSanchez/CapiUploader/issues/new/choose) y llena el formulario con la versión, la plataforma, lo que hacías, el mensaje y el registro.

## Actualizaciones

Con esta versión de prueba, la app se actualiza sola a la **siguiente versión de prueba** y, cuando salga, a la **1.5.0 final**. Para volver antes a la versión final, instala encima el Setup de la **1.4.2**. Tus scans y ajustes se conservan.
