# psdc

Conversor de PSD/PSB a imagen que usa CapiUploader.

- Proyecto: https://github.com/ChoqueCastroLD/psd-compiler-cli (licencia MIT, ver `LICENSE`)
- Versión: psdc 0.1.0, commit `70644acd1dee872ffa8a47834ab20ef851ede72d`
- Compilado para Windows x64 con el toolchain `x86_64-pc-windows-gnu` de Rust:

```bash
git clone https://github.com/ChoqueCastroLD/psd-compiler-cli && cd psd-compiler-cli
git checkout 70644acd1dee872ffa8a47834ab20ef851ede72d
git apply <CapiUploader>/vendor/psdc/keep-text-fallback.patch
cargo build --release --locked   # necesita MinGW (gcc y dlltool) en el PATH
cp target/release/psdc.exe <CapiUploader>/vendor/psdc/
```

## Parche

`keep-text-fallback.patch` (una línea en `src/render/layer.rs`): con `--keep-text`, una capa de texto
que no tiene píxeles guardados se dibuja igualmente en lugar de quedar vacía. CapiUploader usa
`--keep-text` cuando faltan fuentes y, sin el parche, esas capas saldrían sin texto. Aplicarlo con
`git apply keep-text-fallback.patch` antes de compilar.
