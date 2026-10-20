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

## Modos

- **Un capítulo**: arrastra las páginas, marca páginas simples y la destacada, programa y sube.
- **Varios capítulos**: una carpeta por capítulo, de una o varias obras del mismo scan.
  - Soltar `Lote/Obra/Capítulo` reparte los capítulos por obra según el nombre de la carpeta.
  - Cada capítulo elige su acceso: público, anticipado con fecha de liberación o anticipado sin fecha.
  - La programación escalonada lleva una secuencia por obra.

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
pruebas no toquen la del usuario. La app instalada la ignora.

## Estructura

- `src/main/` — proceso principal: cliente de la API, scans y claves, flujo de subida. `psd.js` convierte los PSD.
- `src/preload/` — puente seguro (`window.capi`) entre la UI y el proceso principal.
- `src/renderer/` — interfaz (HTML/CSS/JS sin frameworks). `batch.js` es el modo «Varios capítulos».
- `vendor/psdc/` — conversor de PSD (MIT) que se incluye en el instalador.
