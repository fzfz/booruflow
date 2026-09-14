# Contratos de máquina

Fuentes únicas: `schema/database/` para DB/migraciones; `schema/data-package/` para paquetes; `schema/api/openapi.yaml` para HTTP; `schema/api/error-catalog.json` para errores; `config/` estructurado para valores; `docs/locales.json` y `schema/docs/locales.schema.json` para idiomas.

Modifica primero el Schema o la configuración estructurada, después los validadores y la implementación, añade pruebas normales, de error y límite, y por último actualiza los cuatro idiomas. Los archivos de migración publicados conservan su texto; un cambio estructural añade el número de migración siguiente y actualiza las pruebas de creación, actualización y reversión. Compara las rutas reales y OpenAPI en ambos sentidos. Define los errores en el catálogo y haz que la interfaz lea el mapeo común.

[Configuración](../user/configuration.md) define en un único lugar los valores ajustables durante la ejecución y su orden de aplicación. Los campos, constantes y plantillas compartidas se guardan en una fuente estructurada. Markdown explica el uso; los programas leen los datos estructurados del Schema o de la configuración estructurada correspondiente.
