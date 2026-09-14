# BooruFlow domain vocabulary

| Term | Meaning |
|---|---|
| Installation | One checkout with its own `.env`, database, media and application process. |
| Work | A named work that groups characters. |
| Character | A named resource belonging to one work, with aliases and prompt text. |
| Base model | A catalog category identifying a model family. |
| Style | A named style belonging to one base model, with prompt text and a semantic description. The base-model/name pair identifies it. |
| Model | A model-file catalog record belonging to one base model. The weight file stays outside this application. |
| LoRA | A file catalog record belonging to both a base model and a model, with trigger words and a default weight. |
| Artist prompt string | A reusable sequence of artist names and weights that can relate to a base model and multiple styles. |
| Prompt Tag | A canonical tag with a Danbooru category, aliases and associated image count. |
| Resource image | A media file and its `item_images` record, owner, order and optional cover selection. A template has at most one image. |
| ComfyUI instance | A service address and installation-specific credentials. Imported instances start disabled. |
| ComfyUI template | Catalog metadata and saved Workflow JSON associated with model resources. |
| Catalog | The structured resource-query HTTP/CLI interface. |
| Source | The HTTP/CLI interface for retrieving ComfyUI source and template bundles. |
| Vector space | The configured embedding model and fixed dimension for one resource kind. |
| Data package | Portable resource records and images, defined in `schema/data-package/`; vectors are generated in the target installation. |
| Backup | A local recovery copy of matching code, database, media and configuration. |

See [architecture](docs/en/development/architecture.md) for module ownership, [contracts](docs/en/development/contracts.md) for authoritative structures, and [data transfer](docs/en/user/data-transfer.md) for empty-database import and recovery rules.
