import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { formatWorkflowJsonFile } from '../../app/web/assets/workflow-json-file.mjs';

const pageSource = readFileSync(new URL('../../app/web/assets/comfyui-template-management.js', import.meta.url), 'utf8');
const templatePageHtml = readFileSync(new URL('../../app/web/comfyui-templates.html', import.meta.url), 'utf8');
const legacyPageHtml = readFileSync(new URL('../../app/web/generation-resources.html', import.meta.url), 'utf8');
const functionStart = pageSource.indexOf('function templateFriendlyError');
const functionEnd = pageSource.indexOf('\nasync function templateApi', functionStart);
if (functionStart < 0 || functionEnd < 0) throw new Error('ComfyUI template error presentation function is missing');
const source = `${pageSource.slice(functionStart, functionEnd)}\nglobalThis.__ISSUE_75_TEMPLATE_PAGE__ = { templateFriendlyError };`;

function loadPage() {
  const sandbox = {
    Array, Object,
    globalThis: null
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'app/web/assets/comfyui-template-management.js' });
  return sandbox.__ISSUE_75_TEMPLATE_PAGE__;
}

test('ComfyUI 模板页面仅根据结构化 Workflow 格式明细展示支持版本', () => {
  const { templateFriendlyError } = loadPage();
  assert.equal(
    templateFriendlyError('保存 ComfyUI 模板', { code: 'VALIDATION_ERROR', details: { field: 'template_json', supported_versions: ['0.4', '1.0'] } }),
    '保存 ComfyUI 模板失败：Workflow JSON 必须符合 0.4 或 1.0 格式；当前编辑内容已保留。'
  );
  assert.equal(
    templateFriendlyError('保存 ComfyUI 模板', { code: 'VALIDATION_ERROR', details: { field: 'template_json', supported_versions: ['0.4'] } }),
    '保存 ComfyUI 模板失败：当前填写内容不能保存。请检查必填内容和格式后重试；当前编辑内容已保留。'
  );
});

test('Workflow JSON 文件导入只接受 json 扩展名并用两个空格格式化有效内容', () => {
  assert.equal(formatWorkflowJsonFile('workflow.JSON', '{"3":{"class_type":"KSampler"}}'), '{\n  "3": {\n    "class_type": "KSampler"\n  }\n}');
  assert.throws(() => formatWorkflowJsonFile('workflow.txt', '{}'), /不是 \.json 文件/u);
  assert.throws(() => formatWorkflowJsonFile('broken.json', '{'), /broken\.json.*无效 JSON/u);
});

test('ComfyUI 模板正式页面和旧版页面使用单一编辑表单且没有退役页签', () => {
  for (const html of [templatePageHtml, legacyPageHtml]) {
    assert.match(html, /<form id="template-form">/u);
    assert.match(html, /name="template_json"/u);
    if (html === templatePageHtml) assert.match(html, /accept="\.json,application\/json"/u);
    assert.doesNotMatch(html, /template-workflow-tabs/u);
    assert.doesNotMatch(html, /template-static-panel/u);
    assert.doesNotMatch(html, /template-runtime-panel/u);
    assert.doesNotMatch(html, /template-runtime-test-panel/u);
    assert.doesNotMatch(html, /静态检查与修复|运行参数|实例运行测试/u);
  }
});
