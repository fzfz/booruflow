# Directorios de scripts y comandos de mantenimiento

## Elige las rutas de tu versión

El código actual coloca los comandos de Windows en `bin/windows/` y los de macOS en `bin/macos/`. Desde la raíz de instalación, ejecuta `bin\windows\start.bat` o `bash bin/macos/start.sh`. Para otras operaciones, usa el archivo correspondiente del mismo directorio. Los argumentos se definen en [Operaciones](../user/operations.md), [Actualización y recuperación](../user/update-recovery.md) y [Transferencia de datos](../user/data-transfer.md).

La versión publicada v0.88.0 conserva estos comandos en la raíz. Los comandos de raíz de las guías de instalación y uso corresponden a esa versión. Con el código actual, sustituye cada ruta por el directorio de plataforma indicado arriba. Los adjuntos de Release conservan los nombres independientes `install.bat` e `install.sh`. Consulta [Instalación](../user/installation.md) para elegir el directorio de destino.

Usa el instalador adjunto a la versión de destino. El instalador del código actual requiere la estructura `bin/`; para instalar v0.88.0, utiliza su adjunto original.

## Finalidad de los scripts conservados

| Ubicación | Finalidad |
| --- | --- |
| `scripts/runtime-data.mjs` | Entrada interna para inicialización, actualización, exportación, validación de paquetes e importación. |
| `scripts/start-local-app.mjs` | Inicio y cierre ordenado de la aplicación. |
| `scripts/prod-backup.mjs`, `scripts/prod-restore.mjs` | Copias y restauración de base de datos, medios y configuración. |
| `scripts/platform/` | Implementaciones compartidas que utilizan los scripts nativos del usuario. |
| `scripts/catalog/` | Consultas de Catalog, lectura de fuentes ComfyUI e instalación de CLI. |
| `scripts/maintenance/` | Reconstrucción de vectores de seis tipos de recursos. |
| `scripts/testing/` | Ejecución de pruebas, comprobación de contratos, aplicaciones aisladas e intercambio de datos entre plataformas. |
| `scripts/docs/capture-screenshots.mjs` | Capturas de documentación generadas con datos de ejemplo aislados. |
| `scripts/release/tag.mjs` | Creación y envío de etiquetas mediante `npm run release:tag -- vX.Y.Z` por los mantenedores. |
| `scripts/release/check-job-results.mjs`, `preflight.mjs`, `publish.mjs`, `release-context.mjs` | Comprobación de resultados, verificación previa, entrada de publicación y validación compartida que usa GitHub Actions; consulta los [controles de CI/CD](ci-cd.md) para las condiciones de ejecución. |

Consulta [Pruebas](testing.md), [Catalog/Source](catalog-source.md) y [Publicaciones](releases.md) para los procedimientos correspondientes.

## Reconstruye los vectores

Cuando sea necesario regenerar los vectores de búsqueda, el mantenedor detiene la aplicación, crea una copia de seguridad, comprueba la [configuración de modelos](../user/configuration.md) y ejecuta el comando necesario desde la raíz de instalación:

```bash
node scripts/maintenance/rebuild-work-vectors.mjs --database data/app.sqlite --media-root data/media
```

Sustituye `work` en el nombre por `character`, `style`, `prompt-term`, `generation-lora` o `artist-prompt-string` para procesar ese recurso. Si omites `--reset` y el nombre del modelo no cambia, el comando reutiliza los vectores existentes de longitud válida, repara las entradas KNN ausentes o inconsistentes y llama al modelo para los vectores ausentes o de longitud inválida. Usa `--reset` para volver a vectorizar el contenido. Con `--reset` o un cambio de nombre del modelo, el comando elimina primero los vectores y las entradas KNN de ese tipo y después los reconstruye individualmente. Los fallos conservan los registros completados; confirma que hay una copia de seguridad antes de ejecutar el comando. Comprueba `failures` y el código de salida, resuelve los problemas indicados, inicia la aplicación y verifica la búsqueda. La importación de paquetes crea los vectores de forma síncrona; sigue [Transferencia de datos](../user/data-transfer.md) para esa operación.
