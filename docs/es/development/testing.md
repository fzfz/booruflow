# Pruebas

Ejecuta `npm ci` y usa puertos separados, bases temporales y fixtures fijos. Las pruebas no contactan producción, credenciales reales, sitios reales ni modelos reales.

Los comandos principales son `npm run test:unit`, `npm run test:contract`, `npm run test:integration`, `npm run test:migration`, `npm run test:native`, `npm run test:e2e:files` y `npm test`. `npm run check:test-boundaries` valida los límites estáticos de pruebas y `npm run check:test-markdown` confirma que Markdown no se usa como dato estructurado. Ejecuta primero la capa afectada y luego el conjunto completo.

Las pruebas de contrato verifican Schema, OpenAPI, errores, migraciones y rutas. Las pruebas unitarias cubren las ramas de la lógica, las pruebas de integración verifican la composición de módulos y las transacciones, y las pruebas E2E verifican el comportamiento de las páginas. Prueba los scripts de plataforma en Windows x64 y macOS arm64/x64 para verificar la instalación, el inicio, la detención, la actualización, la restauración y el intercambio de datos. Cada conducta nueva debe cubrir los casos normales, de error y de límite.

Se exige 85% líneas, 80% ramas y 100% en ramas críticas de transacción, recuperación de medios y cliente de consultas. Guarda comando, código, primer error, capa y artefacto; corrige causa y repite controles afectados. CI conserva resultados.
