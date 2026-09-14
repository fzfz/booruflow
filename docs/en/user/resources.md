# Resources

The management home has nine destinations. Works contain characters. Characters store aliases, prompts, and images. Styles store descriptions, prompts, base-model links, and images. Prompt Tags store canonical tags, aliases, categories, and images. Base models classify models, LoRAs, styles, and templates. A model belongs to a base model. A LoRA belongs to a base model and model and stores trigger words, default weight, description, and images. Artist prompt strings are reusable artist expressions that may link to styles. A ComfyUI instance stores a service connection; a template stores Workflow JSON, base-model information, and runtime parameters and can exist independently of an instance.

Create resources in this practical order: base models; works, characters, and styles; Prompt Tags; models; LoRAs; artist prompt strings; ComfyUI instances; templates. On each page, search before creating, then save and search again to verify fields. Image management supports adding, viewing, ordering, choosing a cover, and deleting; confirm the card cover and detail order after saving.

Model and LoRA records store catalog metadata, not weight files. ComfyUI credentials stay in the local environment. Read the displayed references and impact before deleting; resolve dependent records first. Use [Data transfer](data-transfer.md) for complete dataset moves.
