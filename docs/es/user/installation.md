# Instalación

Los comandos de raíz corresponden a v0.88.0 publicada. El código actual usa `bin/`; consulta [Directorios de scripts y mantenimiento](../development/scripts.md).

Los scripts nativos de BooruFlow v0.88.0 se dirigen a Windows x64 y macOS arm64/x64. Requiere Node.js 24.21.0 o posterior, npm 10.9.3 o posterior y Git 2.55.0 o posterior. El instalador también comprueba `tar` y la extensión vectorial de SQLite; `config/release/release.json` es la fuente de requisitos exactos. La página de la versión enumera las plataformas realmente verificadas.

Descarga `install.bat` o `install.sh` desde la [versión v0.88.0](https://github.com/fzfz/booruflow/releases/tag/v0.88.0). En Windows ejecuta el `.bat`; en macOS:

```bash
bash install.sh
```

El script muestra como destino predeterminado el directorio desde el que se inició. Pulsa Intro para aceptarlo o escribe una ruta absoluta o relativa a ese directorio. Tras elegir la versión, comprueba sistema, CPU, permisos, Node, npm y Git; clona la etiqueta; ejecuta `npm ci`; crea `.env`; genera una clave local para credenciales de ComfyUI; e inicializa una base vacía.

Si falta Node o Git, muestra la versión requerida, el sitio oficial y cómo repetir el proceso, y sale. Instala el programa, abre una terminal nueva para actualizar PATH y repite el script. Usa update para una instalación existente y un directorio vacío si hay archivos ajenos.

Configura Embedding y Reranker según [Configuración](configuration.md). “Instalación completada”, junto con ruta, versión y script de inicio, confirma los archivos. “Configuración pendiente” exige completar los servicios de modelos.
