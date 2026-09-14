# Recursos

La portada de gestión tiene nueve destinos. Una obra contiene personajes. Los personajes guardan alias, prompts e imágenes; los estilos, descripción, prompts, base e imágenes; Prompt Tag, etiqueta canónica, alias, categoría e imágenes. El modelo base clasifica modelos, LoRA, estilos y plantillas, y cada modelo pertenece a un solo modelo base. Un LoRA se relaciona con base y modelo y guarda activadores, peso, descripción e imágenes. Una cadena de artistas puede relacionarse con estilos. Una instancia guarda la conexión ComfyUI y una plantilla guarda Workflow JSON, base y parámetros, y puede existir independientemente de una instancia.

Orden recomendado: bases; obras, personajes y estilos; Prompt Tags; modelos; LoRA; cadenas de artistas; instancias; plantillas. Busca antes de crear, guarda y vuelve a buscar. La gestión de imágenes permite añadir, ver, ordenar, elegir portada y borrar; confirma portada y orden después.

Modelos y LoRA guardan metadatos, no pesos. Las credenciales ComfyUI permanecen locales. Lee relaciones e impacto antes de borrar y resuelve dependencias. Para lotes usa [Transferencia](data-transfer.md).
