BEGIN IMMEDIATE;

UPDATE comfyui_templates
SET template_json = (
  SELECT revision.workflow_json
  FROM comfyui_template_current_revisions current
  JOIN comfyui_template_revisions revision
    ON revision.id = current.revision_id
    AND revision.template_id = current.template_id
  WHERE current.template_id = comfyui_templates.id
)
WHERE EXISTS (
  SELECT 1
  FROM comfyui_template_current_revisions current
  JOIN comfyui_template_revisions revision
    ON revision.id = current.revision_id
    AND revision.template_id = current.template_id
  WHERE current.template_id = comfyui_templates.id
);

DROP TABLE comfyui_run_outputs;
DROP TABLE comfyui_runs;
DROP TABLE comfyui_template_asset_references;
DROP TABLE comfyui_template_validation_reports;
DROP TABLE comfyui_template_runtime_configs;
DROP TABLE comfyui_template_current_revisions;
DROP TABLE comfyui_template_sources;
DROP TRIGGER comfyui_template_revision_immutable_before_update;
DROP TABLE comfyui_template_revisions;
DROP TABLE comfyui_model_assets;

INSERT INTO schema_migrations(version, name, applied_at)
VALUES (38, '038-remove-comfyui-template-management', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 38;

COMMIT;
