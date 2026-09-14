# Integración Catalog y Source

Mientras la aplicación funciona, las API internas solo escuchan en la dirección de bucle local de `NOOBAI_INTERNAL_PORT`. Catalog busca o lee diez tipos de recurso: modelos base, modelos de generación, LoRA, obras, personajes, estilos, Prompt Tags, cadenas de artistas, instancias de ComfyUI y plantillas de ComfyUI. Source lee una conexión ComfyUI completa o un paquete de plantilla mediante su ID estable. Lee discovery antes de invocar una operación.

```bash
node scripts/catalog/imagegen-semantic-query.mjs --port 18083 --discovery-json
node scripts/catalog/imagegen-semantic-query.mjs --port 18083 --path /internal/semantic/characters --mode search --query frieren --page 1 --page_size 20
node scripts/catalog/imagegen-semantic-query.mjs --port 18083 --path /internal/semantic/characters --mode lookup --id 12
node scripts/catalog/imagegen-comfyui-source-read.mjs --port 18083 --discovery-json
node scripts/catalog/imagegen-comfyui-source-read.mjs --port 18083 instance --id 31
node scripts/catalog/imagegen-comfyui-source-read.mjs --port 18083 template-bundle --id 7
```

Search utiliza `query`, `page`, `page_size` y los filtros específicos declarados por discovery; lookup utiliza el `id` estable. Un resultado correcto escribe JSON en la salida estándar. Los errores de argumentos, conexión, tiempo de espera, HTTP o contrato devuelven un código distinto de cero. Guarda el código y la salida de error, y comprueba el estado de la aplicación, el puerto interno y la respuesta discovery. Las rutas y los campos completos están en `schema/api/openapi.yaml` y en discovery de la aplicación en ejecución.
