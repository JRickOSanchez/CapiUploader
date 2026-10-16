# CapiUploader

App de escritorio (Electron) para subir capítulos de manga a **Capibara Traductor** con su API v1.

## Uso

```bash
npm install
npm start
```

La primera vez pide la API key (`capi_…`). Se guarda **cifrada** con el almacén seguro de Windows
(DPAPI, vía `safeStorage`) en `%APPDATA%\CapiUploader\config.json`. Se puede cambiar o quitar con el
botón de la llave arriba a la derecha.

## Generar instalador

```bash
npm run dist   # crea el .exe en dist/
```

## Cómo funciona

1. `POST /uploads` firma URLs para todas las páginas (lotes de 100).
2. Cada imagen se sube con `PUT` directo al almacenamiento (4 en paralelo, con reintentos).
3. `POST /works/:id/chapters` crea el capítulo con las claves en orden de lectura.

Si la creación falla (p. ej. número repetido), las páginas ya subidas se reutilizan durante 45 min al
reintentar. Las peticiones a la API reintentan solas ante `429` (respetando `Retry-After`) y errores `5xx`.

La API key vive solo en el proceso principal; la interfaz nunca la ve.

## Estructura

- `src/main/` — proceso principal: cliente de la API, guardado de la clave, flujo de subida.
- `src/preload/` — puente seguro (`window.capi`) entre la UI y el proceso principal.
- `src/renderer/` — interfaz (HTML/CSS/JS sin frameworks).
