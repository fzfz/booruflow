# Operación

Los comandos de raíz corresponden a v0.88.0 publicada. El código actual usa `bin/`; consulta [Directorios de scripts y mantenimiento](../development/scripts.md).

Los scripts instalados localizan la aplicación desde su propia ruta. Ejecuta `.bat` en Windows y `bash nombre.sh` en macOS.

- `start` comprueba Node/npm, dependencias, configuración y puertos; inicia en terminal visible y muestra URL y logs.
- `status` muestra proceso, puertos y URL de esta instalación.
- `stop` pide cierre normal solo a esta instalación y espera HTTP y SQLite.
- `check` valida versiones, permisos, configuración, puertos, tar, extensión SQLite y base.
- `backup` y `restore` procesan base, medios, cola de limpieza y configuración con la aplicación detenida.

Ctrl+C requiere esperar el mensaje de cierre. Inicio duplicado, puerto ocupado y timeout devuelven estado distinto de cero y el objeto afectado. Los logs están por defecto en `data/diagnostics/`. Tras cambiar `.env`, reinicia y verifica check/status. Sustituye secretos y rutas personales antes de adjuntar logs.
