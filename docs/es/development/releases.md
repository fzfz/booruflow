# Versiones

Se usa SemVer y etiquetas Git con `v`. `config/release/` define datos compartidos por instaladores, update, README y adjuntos.

Antes de publicar actualiza paquete y cuatro changelogs, confirma migración/recuperación y ejecuta contract, unit, integration, e2e, enlaces y scripts de plataforma. Declara solo arquitecturas Windows/macOS verificadas. Etiqueta, paquete, rango DB y formato deben coincidir.

Adjunta `install.bat` y `install.sh` independientes, notas en cuatro idiomas y enlaces de instalación, plataformas y recuperación. Tras publicar, haz fresh clone y verifica descarga, instalación, configuración, start/status/stop y export/import de la misma versión.

Ante un fallo conserva el respaldo y la identidad de la versión anterior, y restaura el código, la base de datos, los medios y la configuración coincidentes. Después comprueba la restauración, el inicio, la versión y los recursos; registra la recuperación correcta antes de preparar una versión corregida. v0.88.0 inicia el historial público.

[Controles de CI/CD](ci-cd.md)
