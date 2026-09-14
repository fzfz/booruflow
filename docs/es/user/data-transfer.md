# Transferencia de datos

Los comandos de raíz corresponden a v0.88.0 publicada. El código actual usa `bin/`; consulta [Directorios de scripts y mantenimiento](../development/scripts.md).

Detén la aplicación, exporta a un directorio nuevo y empaqueta:

```bash
bash data-export.sh --output /path/to/export-dir
bash data-pack.sh --input /path/to/export-dir --output /path/to/booruflow-data.tar.gz
```

`--include-instances` incluye solo nombres y URL ComfyUI; llegan desactivadas y pendientes. El paquete incluye obras, personajes, estilos, Prompt Tags, bases, modelos, LoRA, cadenas de artistas, relaciones, plantillas, Workflow JSON y medios. Excluye pesos, sesiones, historial, logs, rutas absolutas y credenciales.

El destino debe tener el esquema actual y cero filas en tablas de negocio, relaciones, imágenes, vectores y KNN. Puede contener migraciones y metadatos iniciales `vector_spaces`. Configura las direcciones, los nombres de modelo y la autenticación de Embedding y Reranker siguiendo [Configuración](configuration.md), y ejecuta:

```bash
bash data-import.sh --input /path/to/booruflow-data.tar.gz --check
bash data-import.sh --input /path/to/booruflow-data.tar.gz --apply
```

`--check` valida la base vacía, la configuración, el formato, la versión, las rutas, los medios y las referencias sin escribir. `--apply` vuelve a comprobar que la base está vacía y sigue las reglas de búsqueda existentes al generar sincrónicamente los vectores de 1.024 dimensiones. Las obras desactivadas, los personajes desactivados y los personajes cuya obra está desactivada conservan sus registros de negocio, pero no entran en el conjunto de vectores consultables. Los demás registros que se pueden buscar normalmente entre obras, personajes, estilos, Prompt Tags, LoRA y cadenas de artistas reciben vectores. Después confirma los registros de negocio, medios, vectores e índices KNN como un solo lote. Un fallo anterior a la confirmación revierte las escrituras del lote y limpia sus archivos. Si falla la comprobación o la preparación de vectores, o si otro fallo anterior a la confirmación ya ha completado la reversión y la limpieza, corrige el problema indicado y repite la comprobación y la importación completa. Si la ejecución se interrumpe o la limpieza falla después de mostrar un ID de lote, ejecuta `bash data-import.sh --recover --batch ID` con ese ID. La recuperación limpia un lote sin confirmar; si ya está confirmado, conserva los datos importados y elimina los archivos temporales. Windows usa el `.bat` correspondiente.

Una sola fila provoca error con tabla y cantidad. Tras un éxito, repetir también falla porque el destino ya no está vacío. v0.88.0 admite paquetes de la misma versión e intercambio Windows/macOS. Un formato desconocido, una base más nueva o una versión fuera del rango admitido termina antes de escribir; utiliza la versión de BooruFlow que corresponda al paquete.
