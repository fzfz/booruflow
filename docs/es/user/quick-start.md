# Inicio rápido

Completa [instalación](installation.md) y [configuración](configuration.md).

Para crear datos a mano, ejecuta `start.bat` o `bash start.sh`, abre la URL pública y crea primero un modelo base. Añade obras, personajes y estilos; relaciona modelos con su base y LoRA con base y modelo. Busca cada registro, abre sus detalles y añade imágenes.

Para importar un paquete de ejemplo o datos de otra instalación v0.88.0, mantén la aplicación detenida. Un origen v0.87.0 debe seguir antes [Actualización y recuperación](update-recovery.md#trasladar-datos-a-una-instalación-v0880-nueva) para actualizar una copia aislada hasta la migración 040 y exportar con scripts v0.88.0.

```bash
bash data-import.sh --input /path/to/package.tar.gz --check
bash data-import.sh --input /path/to/package.tar.gz --apply
bash start.sh
```

En Windows usa los `.bat`. Solo se acepta una base inicializada sin datos de negocio y se generan sincrónicamente vectores de 1.024 dimensiones para seis tipos. Tras importar, inicia, busca un nombre y comprueba detalles, imágenes, portadas y relaciones. Código 0, status activo y páginas accesibles completan el primer uso.
