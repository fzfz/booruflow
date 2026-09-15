# Controles de CI/CD

## Fusionar código

Los colaboradores incorporan cambios a `main` mediante PR. La regla de GitHub `main CI gate` exige una rama actualizada, conversaciones de revisión resueltas y la comprobación `CI Gate` de GitHub Actions aprobada. Esta comprobación reúne los resultados de Windows, macOS Apple Silicon, macOS Intel y el intercambio de datos entre plataformas. Si cualquier tarea previa falla, se cancela o se omite, el control falla.

La regla exige cero aprobaciones de otras personas para que un único mantenedor pueda fusionar su propio PR. Los mantenedores siguen las [normas de PR](../community/pull-requests.md). La regla también se aplica a administradores y exige un historial lineal. Usa squash o rebase, conserva la rama principal y corrige los errores mediante nuevos commits.

## Publicar una versión

El mantenedor prepara la versión según [Publicaciones](releases.md), fusiona sus cambios mediante PR y crea una etiqueta de versión. `Release checks` verifica el formato de la etiqueta, que su commit pertenezca a `main`, la concordancia entre la versión del paquete, la etiqueta predeterminada del instalador y la versión de aplicación del paquete de datos, y la existencia de `docs/releases/vX.Y.Z.md`. El mantenedor redacta ese archivo según los requisitos de notas de [Publicaciones](releases.md). El script envía el archivo completo a GitHub como descripción de la publicación.

`Release Gate` exige que pasen las comprobaciones previas, las pruebas de las tres plataformas, la instalación real de la etiqueta y el intercambio de datos. Después, la tarea de publicación entra en el entorno `github-release` y espera a que `fzfz` revise la etiqueta, el commit y los resultados en GitHub Actions y la apruebe. Tras la aprobación, crea un borrador, adjunta `install.bat` e `install.sh` y publica el borrador. Las ejecuciones manuales en ramas normales solo realizan comprobaciones.

Las publicaciones existentes se conservan. Si una carga falla y deja un borrador, revísalo y elimina ese borrador incompleto antes de repetir la tarea fallida; el script rechaza publicaciones existentes. La regla `immutable release tags` conserva todas las etiquetas `v*` y sus destinos. Usa una etiqueta nueva para una versión corregida. La aprobación del entorno controla las tareas de publicación de Actions; los administradores del repositorio todavía pueden cambiar la configuración u operar las publicaciones manualmente.

## Consultar un fallo

La página del PR muestra `CI Gate`; `Platform checks` en Actions proporciona los resultados de cada plataforma. Si una publicación falla, consulta el paso fallido de `Release checks`, resuelve el problema y repite las comprobaciones. Consulta [Pruebas](testing.md) para el alcance y los requisitos de cobertura.
