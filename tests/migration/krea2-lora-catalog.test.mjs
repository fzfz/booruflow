import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openCatalogDatabase } from '../../app/catalog/database.mjs';
import { listOrderedMigrations } from '../../app/database/migration-baseline.mjs';

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const migrationDirectory = resolve(repositoryRoot, 'schema/database');
const migration23 = readFileSync(resolve(migrationDirectory, '023-krea2-lora-catalog.sql'), 'utf8');
const targetModelFile = 'Krea2-MuseByStable_v15Turbo_GGUF_Q4.gguf';
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openVersion22Database({ includeBuiltinComfyuiCatalog = true } = {}) {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'noobai-krea2-v22-'));
  temporaryDirectories.push(temporaryRoot);
  const targetDirectory = resolve(temporaryRoot, 'schema/database');
  mkdirSync(targetDirectory, { recursive: true });
  for (const migration of listOrderedMigrations(migrationDirectory).filter(({ version }) => version <= 22)) {
    cpSync(migration.path, resolve(targetDirectory, migration.path.split('/').at(-1)));
  }
  const database = openCatalogDatabase({ repositoryRoot: temporaryRoot, includeBuiltinComfyuiCatalog });
  assert.equal(database.prepare('PRAGMA user_version').get().user_version, 22);
  return database;
}

function targetModelId(database) {
  return database.prepare(`SELECT MIN(model.id) AS id
    FROM generation_models model
    JOIN generation_base_models base ON base.id = model.base_model_id
    WHERE base.name = 'krea2' AND model.file_name = ?`).get(targetModelFile).id;
}

function rows(database, sql, ...parameters) {
  return database.prepare(sql).all(...parameters).map((row) => ({ ...row }));
}

function schemaSnapshot(database) {
  return rows(database, `SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name`);
}

function kreaLoraRows(database) {
  return rows(database, `SELECT lora.*
    FROM generation_loras lora
    JOIN generation_base_models base ON base.id = lora.base_model_id
    WHERE base.name = 'krea2'
    ORDER BY lora.id`);
}

function selectedModelLoras(database) {
  return rows(database, `SELECT lora.*
    FROM generation_loras lora
    WHERE lora.model_id = ?
    ORDER BY lora.id`, targetModelId(database));
}

function insertModel(database, { fileName, fileFormat = 'other', precision = 'other' }) {
  return database.prepare(`INSERT INTO generation_models(
      base_model_id, file_name, file_format, precision_or_quantization,
      description, usage, created_at, updated_at
    ) SELECT id, ?, ?, ?, 'extra model', 'extra model usage', ?, ?
      FROM generation_base_models WHERE name = 'krea2'`)
    .run(fileName, fileFormat, precision, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z').lastInsertRowid;
}

function insertLora(database, {
  modelId,
  fileName,
  fileFormat = 'safetensors',
  precision = 'none',
  version = null,
  description = 'existing description',
  usage = 'existing usage'
}) {
  return database.prepare(`INSERT INTO generation_loras(
      base_model_id, model_id, file_name, file_format, precision_or_quantization,
      author, version, release_url, description, usage, cover_media_path,
      created_at, updated_at
    ) SELECT base_model_id, ?, ?, ?, ?, 'existing author', ?, 'https://example.test/lora', ?, ?,
        'covers/existing.png', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
      FROM generation_models WHERE id = ?`)
    .run(modelId, fileName, fileFormat, precision, version, description, usage, modelId).lastInsertRowid;
}

test('023 imports 54 Krea2 LoRAs into the existing table without changing the schema', () => {
  const database = openVersion22Database();
  try {
    const beforeSchema = schemaSnapshot(database);
    const selectedModel = targetModelId(database);
    const asianMixBefore = { ...database.prepare(`SELECT * FROM generation_loras
      WHERE model_id = ? AND file_name = 'Krea2-亚洲asianMix_v1-bf16.safetensors'`).get(selectedModel) };
    const otherBindingsBefore = rows(database, `SELECT lora.*
      FROM generation_loras lora
      JOIN generation_base_models base ON base.id = lora.base_model_id
      WHERE base.name = 'krea2' AND lora.model_id <> ?
      ORDER BY lora.id`, selectedModel);

    database.exec(migration23);

    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 23);
    assert.deepEqual({ ...database.prepare('SELECT version, name FROM schema_migrations WHERE version = 23').get() }, {
      version: 23,
      name: '023-krea2-lora-catalog'
    });
    assert.deepEqual(schemaSnapshot(database), beforeSchema);
    assert.equal(targetModelId(database), selectedModel);
    assert.equal(selectedModelLoras(database).length, 54);
    assert.equal(new Set(selectedModelLoras(database).map(({ file_name: fileName }) => fileName)).size, 54);
    assert.equal(kreaLoraRows(database).length, 57);
    assert.deepEqual(rows(database, `SELECT lora.*
      FROM generation_loras lora
      JOIN generation_base_models base ON base.id = lora.base_model_id
      WHERE base.name = 'krea2' AND lora.model_id <> ?
      ORDER BY lora.id`, selectedModel), otherBindingsBefore);

    const asianMixAfter = { ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(asianMixBefore.id) };
    assert.equal(asianMixAfter.id, asianMixBefore.id);
    assert.equal(asianMixAfter.created_at, asianMixBefore.created_at);
    for (const column of ['file_format', 'precision_or_quantization', 'author', 'version', 'release_url', 'cover_media_path']) {
      assert.equal(asianMixAfter[column], asianMixBefore[column]);
    }
    assert.equal(asianMixAfter.description, 'LoRA 特点：\n- 亚洲人像、脸部调整、写实脸部和摄影方向。');
    assert.equal(asianMixAfter.usage, '触发词：未记录\n权重资料：\n- 模型权重：工作流实测 0.8；推荐权重：未确认；资料状态：工作流实测；权重变化：未记录\n其他用法：未记录');
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('023 creates the target GGUF model when an environment does not have it', () => {
  const database = openVersion22Database({ includeBuiltinComfyuiCatalog: false });
  try {
    const timestamp = '2026-01-01T00:00:00Z';
    database.prepare('INSERT INTO generation_base_models(name, created_at, updated_at) VALUES (?, ?, ?)')
      .run('krea2', timestamp, timestamp);
    insertModel(database, { fileName: 'environment-existing-model.gguf', fileFormat: 'gguf' });
    assert.equal(targetModelId(database), null);
    const otherModelsBefore = rows(database, `SELECT model.*
      FROM generation_models model
      JOIN generation_base_models base ON base.id = model.base_model_id
      WHERE base.name = 'krea2'
      ORDER BY model.id`);

    database.exec(migration23);

    const createdModel = database.prepare(`SELECT model.*
      FROM generation_models model
      JOIN generation_base_models base ON base.id = model.base_model_id
      WHERE base.name = 'krea2' AND model.file_name = ?`).get(targetModelFile);
    assert.ok(createdModel);
    assert.equal(createdModel.file_format, 'gguf');
    assert.equal(createdModel.precision_or_quantization, 'none');
    assert.equal(createdModel.description, 'ComfyUI 内置模板登记的 krea2 主模型。');
    assert.equal(createdModel.usage, '用于对应的内置 ComfyUI Workflow。');
    assert.equal(selectedModelLoras(database).length, 54);
    assert.deepEqual(rows(database, `SELECT model.*
      FROM generation_models model
      JOIN generation_base_models base ON base.id = model.base_model_id
      WHERE base.name = 'krea2' AND model.file_name <> ?
      ORDER BY model.id`, targetModelFile), otherModelsBefore);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('023 selects the smallest same-name model id and does not modify a larger-model LoRA', () => {
  const database = openVersion22Database();
  try {
    const selectedModel = targetModelId(database);
    const largerModel = insertModel(database, { fileName: targetModelFile });
    assert.ok(largerModel > selectedModel);
    const largerLoraId = insertLora(database, {
      modelId: largerModel,
      fileName: 'Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors'
    });
    const largerLoraBefore = { ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(largerLoraId) };

    database.exec(migration23);

    assert.equal(targetModelId(database), selectedModel);
    assert.equal(selectedModelLoras(database).length, 54);
    assert.deepEqual({ ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(largerLoraId) }, largerLoraBefore);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM generation_loras
      WHERE model_id = ? AND file_name = 'Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors'`).get(selectedModel).count, 1);
  } finally {
    database.close();
  }
});

test('023 updates only the smallest existing LoRA id for the selected model and file name', () => {
  const database = openVersion22Database();
  try {
    const modelId = targetModelId(database);
    const firstId = insertLora(database, {
      modelId,
      fileName: 'Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors',
      precision: 'fp16',
      version: 'first'
    });
    const secondId = insertLora(database, {
      modelId,
      fileName: 'Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors',
      precision: 'bf16',
      version: 'second'
    });
    const firstBefore = { ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(firstId) };
    const secondBefore = { ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(secondId) };

    database.exec(migration23);

    const firstAfter = { ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(firstId) };
    assert.equal(firstAfter.description, 'LoRA 特点：\n- 高质量动漫截图风格。');
    assert.equal(firstAfter.usage, '触发词：A high-quality anime screencap\n权重资料：\n- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录\n其他用法：未记录');
    for (const column of ['id', 'file_format', 'precision_or_quantization', 'author', 'version', 'release_url', 'cover_media_path', 'created_at']) {
      assert.equal(firstAfter[column], firstBefore[column]);
    }
    assert.deepEqual({ ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(secondId) }, secondBefore);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM generation_loras
      WHERE model_id = ? AND file_name = 'Krea2-更好的动漫BetterAnimeStyle_Krea2_v1.safetensors'`).get(modelId).count, 2);
  } finally {
    database.close();
  }
});

test('023 preserves extra models and LoRAs that are outside the 54-file catalog', () => {
  const database = openVersion22Database();
  try {
    const selectedModel = targetModelId(database);
    const extraTargetLoraId = insertLora(database, { modelId: selectedModel, fileName: 'user-extra-target.safetensors' });
    const otherModel = database.prepare(`SELECT model.id
      FROM generation_models model
      JOIN generation_base_models base ON base.id = model.base_model_id
      WHERE base.name = 'krea2' AND model.id <> ?
      ORDER BY model.id LIMIT 1`).get(selectedModel).id;
    const extraOtherLoraId = insertLora(database, { modelId: otherModel, fileName: 'user-extra-other.safetensors' });
    const extraModelId = insertModel(database, { fileName: 'user-extra-model.gguf', fileFormat: 'gguf' });
    const before = {
      targetLora: { ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(extraTargetLoraId) },
      otherLora: { ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(extraOtherLoraId) },
      model: { ...database.prepare('SELECT * FROM generation_models WHERE id = ?').get(extraModelId) }
    };

    database.exec(migration23);

    assert.deepEqual({ ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(extraTargetLoraId) }, before.targetLora);
    assert.deepEqual({ ...database.prepare('SELECT * FROM generation_loras WHERE id = ?').get(extraOtherLoraId) }, before.otherLora);
    assert.deepEqual({ ...database.prepare('SELECT * FROM generation_models WHERE id = ?').get(extraModelId) }, before.model);
    assert.equal(selectedModelLoras(database).length, 55);
    assert.equal(new Set(selectedModelLoras(database).map(({ file_name: fileName }) => fileName)).size, 55);
  } finally {
    database.close();
  }
});

test('023 rolls back all catalog writes when one LoRA insert fails', () => {
  const database = openVersion22Database();
  const directory = mkdtempSync(resolve(tmpdir(), 'noobai-krea2-rollback-'));
  temporaryDirectories.push(directory);
  const databasePath = resolve(directory, 'catalog.sqlite');
  let before;
  try {
    before = kreaLoraRows(database);
    database.exec(`CREATE TRIGGER reject_krea2_catalog_lora
      BEFORE INSERT ON generation_loras
      WHEN NEW.file_name = 'Krea2-炭笔素描.safetensors'
      BEGIN SELECT RAISE(ABORT, 'fixture rejects catalog lora'); END;`);
    database.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}';`);
  } finally {
    database.close();
  }

  assert.throws(
    () => openCatalogDatabase({ databasePath, repositoryRoot, includeBuiltinComfyuiCatalog: true }),
    /cannot initialize catalog database: fixture rejects catalog lora/u
  );

  const reopened = new DatabaseSync(databasePath);
  try {
    reopened.exec('PRAGMA foreign_keys = ON;');
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 22);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 23').get().count, 0);
    assert.deepEqual(kreaLoraRows(reopened), before);
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    reopened.close();
  }
});

test('023 keeps model characteristics in description and invocation methods in usage', () => {
  const database = openVersion22Database();
  try {
    database.exec(migration23);
    const byFileName = database.prepare('SELECT description, usage FROM generation_loras WHERE model_id = ? AND file_name = ?');
    assert.deepEqual({ ...byFileName.get(targetModelId(database), 'Krea2-漫画风格ogipote-ep63.safetensors') }, {
      description: 'LoRA 特点：\n- Ogipote 漫画风格。',
      usage: '触发词：Ogipote style\n权重资料：\n- 模型权重：推荐 1；资料状态：用户推荐；权重变化：未记录\n其他用法：建议把触发词放在提示词开头或结尾。'
    });
    assert.deepEqual({ ...byFileName.get(targetModelId(database), 'Krea2-BBW型thickness.safetensors') }, {
      description: 'LoRA 特点：\n- 体型厚度方向调整。',
      usage: '触发词：thicc\n权重资料：\n- 模型权重范围：0.5～1；推荐权重：未记录；资料状态：作者资料；权重变化：用于体型厚度方向调整；作者样例常用 0.9，但该样例点不构成作者推荐值；资料未逐点描述区间内部变化。\n其他用法：建议使用 Euler 或 Euler a 采样器，并使用至少 8 步。'
    });
    assert.deepEqual({ ...byFileName.get(targetModelId(database), 'Krea2-realism-V2.safetensors') }, {
      description: 'LoRA 特点：\n- 表情优化。\n- 真实纹理、自然光、构图和面部表现方向。',
      usage: '触发词：未记录\n权重资料：\n- 模型权重范围：0.7～0.8；推荐权重：未记录；资料状态：待验证；权重变化：未记录\n其他用法：建议搭配轻量 LoRA 或相关节点。'
    });
    assert.deepEqual({ ...byFileName.get(targetModelId(database), 'krea2_identity_edit_v1_2_编辑模型.safetensors') }, {
      description: 'LoRA 特点：\n- 支持 likeness、换脸、重绘、扩图、试穿和人物移除。',
      usage: '触发词：未记录\n权重资料：\n- 模型权重：推荐 1；资料状态：作者资料；权重变化：未记录\n其他用法：使用 Turbo 模型时建议 8–12 步、CFG 1.0。'
    });
    assert.deepEqual({ ...byFileName.get(targetModelId(database), 'krea2_darkbrush.safetensors') }, {
      description: 'LoRA 特点：未记录',
      usage: '触发词：未记录\n权重资料：未记录；推荐权重：未记录；权重变化：未记录\n其他用法：未记录'
    });
  } finally {
    database.close();
  }
});

test('023 is treated as built-in data while later structural migrations still run when the built-in catalog is disabled', () => {
  const database = openCatalogDatabase({ includeBuiltinComfyuiCatalog: false });
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 40);
    assert.deepEqual({ ...database.prepare('SELECT version, name FROM schema_migrations WHERE version = 23').get() }, {
      version: 23,
      name: '023-krea2-lora-catalog'
    });
    assert.deepEqual({ ...database.prepare('SELECT version, name FROM schema_migrations WHERE version = 24').get() }, {
      version: 24,
      name: '024-generation-lora-trigger-weight'
    });
    for (const table of ['generation_base_models', 'generation_models', 'generation_loras', 'comfyui_templates']) {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
  } finally {
    database.close();
  }
});

test('023 contains data changes only', () => {
  assert.doesNotMatch(migration23, /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIEW)\b/iu);
  assert.match(migration23, /INSERT INTO schema_migrations\(version, name, applied_at\)/u);
  assert.match(migration23, /PRAGMA user_version = 23;/u);
});
