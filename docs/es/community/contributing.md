# Contribuir

Utiliza [Instalación](../user/installation.md) como fuente única para herramientas, versiones y preparación de plataforma. Haz fork de `fzfz/booruflow`, clona tu fork, entra en el repositorio y ejecuta `npm ci` seguido de `node scripts/runtime-data.mjs init --root "$PWD"`. Si `.env` no existe, copia `.env.example`; elige puertos de desarrollo independientes y completa las seis variables de Embedding/Reranker de [Configuración](../user/configuration.md), conservando cualquier `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY` existente. Ejecuta `bash check.sh` y `bash start.sh` en macOS, o `check.bat` y `start.bat` en Windows. Cuando check pase y se abra la página de gestión, detén la aplicación y crea una rama breve para el objetivo. En Windows sustituye `"$PWD"` por la ruta absoluta, por ejemplo `node scripts\runtime-data.mjs init --root "C:\path\to\booruflow"`.

Un problema por PR. Arreglos pequeños pueden ir directos; cambios HTTP, DB, contrato de configuración o conducta requieren Issue previo. Actualiza primero el contrato de máquina, luego implementación, pruebas normales/error/límite y documentación.

Ejecuta pruebas afectadas y `npm test`; consulta [Pruebas](../development/testing.md). `docs/locales.json` relaciona temas. Cambios de uso actualizan los cuatro idiomas con los mismos comandos, parámetros, campos y valores; lee cada traducción antes de marcarla complete.

Describe problema, resultado, alcance, Issue y pruebas según [PR](pull-requests.md). Usa [Soporte](support.md) para ayuda. Las contribuciones usan [MIT License](../../../LICENSE).
