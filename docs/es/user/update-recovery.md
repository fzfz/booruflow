# Actualización y recuperación

Consulta status, detén y ejecuta `update.bat --tag vX.Y.Z` o `bash update.sh --tag vX.Y.Z` para indicar la etiqueta de destino. Antes de escribir comprueba Git, cambios locales, dirección de versión, versión de base y parada. Luego crea backup, obtiene etiqueta, hace checkout, `npm ci`, migración y health check temporal. El usuario inicia después del éxito.

Los cambios locales, una degradación, una versión desconocida de la base o una instalación sin Git detienen la actualización con una solución concreta. Un fallo conserva el respaldo y la identidad anterior. Pasa el directorio directo mostrado por update a `restore.bat --backup data/recovery/<backup-directory>` o `bash restore.sh --backup data/recovery/<backup-directory>`; el argumento debe ser un único hijo directo de `data/recovery/`. La recuperación restaura el código, la base, los medios y la configuración correspondientes. Después ejecuta la comprobación, inicia y verifica la versión y los recursos.

## Trasladar datos a una instalación v0.88.0 nueva

Los paquetes admiten exportación e importación entre la misma versión. Para trasladar una v0.88.0 a otra v0.88.0, detén el origen y ejecuta `data-export` y `data-pack`. Mantén detenido el destino, configura ambos servicios de modelos, ejecuta `data-import --check` y `--apply` sobre su base vacía, y después inicia y verifica. [Transferencia de datos](data-transfer.md) contiene todos los argumentos.

Un despliegue v0.87.0 no contiene los scripts de operación del repositorio nuevo ni su etiqueta `v0.88.0`. Detén la aplicación mediante el método utilizado por ese despliegue y confirma que terminaron su proceso y sus puertos. Este ejemplo usa `/path/to/booruflow-v087` como origen, `/path/to/booruflow-v087-backup` como respaldo completo y `/path/to/booruflow-v088-export-copy` como código aislado clonado del repositorio público nuevo. Los directorios del respaldo completo y de la copia aislada deben estar ausentes o vacíos al comenzar. `/path/to/booruflow-v088-target` representa un destino v0.88.0 instalado por separado y con la base de negocio vacía; no es uno de esos dos destinos de copia.

```bash
ditto "/path/to/booruflow-v087" "/path/to/booruflow-v087-backup"
git clone --branch v0.88.0 --depth 1 https://github.com/fzfz/booruflow.git "/path/to/booruflow-v088-export-copy"
ditto "/path/to/booruflow-v087-backup/data" "/path/to/booruflow-v088-export-copy/data"
cp "/path/to/booruflow-v087-backup/.env" "/path/to/booruflow-v088-export-copy/.env"
```

Conserva la base de datos copiada en el directorio aislado. Compara el `.env` copiado con el `.env.example` nuevo, coloca la configuración de usuario antigua en las variables nuevas correspondientes, completa las seis variables de Embedding y Reranker y conserva `NOOBAI_COMFYUI_CREDENTIAL_ENCRYPTION_KEY` y las demás credenciales copiadas. Después de `npm ci`, ejecuta directamente `runtime-data.mjs migrate` para actualizar esa base.

Por separado, sigue [Instalación](installation.md) y usa el instalador v0.88.0 para crear `/path/to/booruflow-v088-target`. Completa en el destino las seis variables de Embedding y Reranker descritas en [Configuración](configuration.md). Mantén detenida la aplicación de destino y confirma que sus tablas de negocio, relaciones, imágenes, vectores y KNN están vacías. Después ejecuta, en este orden, la migración, la exportación, el empaquetado y la importación:

```bash
npm --prefix "/path/to/booruflow-v088-export-copy" ci
node "/path/to/booruflow-v088-export-copy/scripts/runtime-data.mjs" migrate --root "/path/to/booruflow-v088-export-copy"
bash "/path/to/booruflow-v088-export-copy/data-export.sh" --output "/path/to/v088-export"
bash "/path/to/booruflow-v088-export-copy/data-pack.sh" --input "/path/to/v088-export" --output "/path/to/v088-data.tar.gz"
bash "/path/to/booruflow-v088-target/data-import.sh" --input "/path/to/v088-data.tar.gz" --check
bash "/path/to/booruflow-v088-target/data-import.sh" --input "/path/to/v088-data.tar.gz" --apply
```

La migración avanza la base aislada de 039 a 040. En Windows detén el despliegue antiguo con su método existente y confirma su salida. Ejecuta lo siguiente en el símbolo del sistema; los directorios del respaldo completo y de la copia aislada deben estar ausentes o vacíos:

```bat
robocopy "C:\path\to\booruflow-v087" "C:\path\to\booruflow-v087-backup" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
git clone --branch v0.88.0 --depth 1 https://github.com/fzfz/booruflow.git "C:\path\to\booruflow-v088-export-copy"
robocopy "C:\path\to\booruflow-v087-backup\data" "C:\path\to\booruflow-v088-export-copy\data" /E /COPY:DAT /DCOPY:DAT /R:1 /W:1
copy /Y "C:\path\to\booruflow-v087-backup\.env" "C:\path\to\booruflow-v088-export-copy\.env"
```

Confirma que cada `robocopy` devuelve 0–7; 8 o más indica fallo y detiene el procedimiento. Conserva la base de datos copiada en el directorio aislado. Ajusta el `.env` aislado según el `.env.example` nuevo, traslada la configuración del usuario, completa las seis variables de modelos y conserva la clave y las credenciales. Después de `npm ci`, ejecuta directamente `runtime-data.mjs migrate` y continúa con estos comandos:

```bat
call npm --prefix "C:\path\to\booruflow-v088-export-copy" ci
node "C:\path\to\booruflow-v088-export-copy\scripts\runtime-data.mjs" migrate --root "C:\path\to\booruflow-v088-export-copy"
call "C:\path\to\booruflow-v088-export-copy\data-export.bat" --output "C:\path\to\v088-export"
call "C:\path\to\booruflow-v088-export-copy\data-pack.bat" --input "C:\path\to\v088-export" --output "C:\path\to\v088-data.tar.gz"
call "C:\path\to\booruflow-v088-target\data-import.bat" --input "C:\path\to\v088-data.tar.gz" --check
call "C:\path\to\booruflow-v088-target\data-import.bat" --input "C:\path\to\v088-data.tar.gz" --apply
```

Si el destino contiene datos de negocio, crea otro destino vacío en vez de fusionar. Detén los pasos posteriores si falla la copia, la instalación de dependencias, la migración o la exportación; conserva el respaldo completo y vuelve a crear el directorio aislado. El despliegue original permanece sin cambios.
