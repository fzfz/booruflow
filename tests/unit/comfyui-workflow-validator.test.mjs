import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isComfyuiWorkflowV04,
  isComfyuiWorkflowV1,
  isSupportedComfyuiWorkflow
} from '../../app/generation-resources/comfyui-workflow-validator.mjs';

function inputPort(overrides = {}) {
  return { name: 'image', type: 'IMAGE', link: null, links: [1], slot_index: 'input-slot', ...overrides };
}

function outputPort(overrides = {}) {
  return { name: 'image', type: ['IMAGE'], link: 1, links: null, slot_index: 0, ...overrides };
}

function node(overrides = {}) {
  return {
    id: 1,
    type: 'ValidatorNode',
    pos: [0, 1],
    size: { 0: 2, 1: 3 },
    flags: {},
    order: 0,
    mode: 0,
    properties: {},
    inputs: [inputPort()],
    outputs: [outputPort()],
    ...overrides
  };
}

function model(overrides = {}) {
  return {
    name: 'validator.safetensors',
    url: 'https://example.test/validator.safetensors',
    hash: 'abc',
    hash_type: 'sha256',
    directory: 'models/checkpoints',
    ...overrides
  };
}

function workflowV04(overrides = {}) {
  return {
    version: 0.4,
    last_node_id: '1',
    last_link_id: 1,
    nodes: [node()],
    links: [[1, '1', 0, 2, '0', 7]],
    groups: [{ title: 'Group', bounding: [0, 1, 2, 3] }],
    config: {},
    extra: {},
    models: [model()],
    ...overrides
  };
}

function workflowV1(overrides = {}) {
  return {
    version: 1,
    state: {},
    nodes: [node({ id: 'node-1' })],
    config: null,
    groups: [{ title: 'Group', bounding: [0, 1, 2, 3] }],
    links: [{
      id: 1,
      origin_id: 'node-1',
      origin_slot: 0,
      target_id: 2,
      target_slot: 'input',
      type: ['IMAGE'],
      parentId: 4
    }],
    reroutes: [{ id: 1, pos: { 0: 3, 1: 4 }, parentId: 2, linkIds: [1] }],
    extra: null,
    models: [model({ hash: undefined, hash_type: undefined })],
    ...overrides
  };
}

function mutate(source, callback) {
  const copy = structuredClone(source);
  callback(copy);
  return copy;
}

test('ComfyUI Workflow 校验器接受完整 0.4、1.0 和省略可选属性的结构', () => {
  const v04 = workflowV04();
  const v1 = workflowV1();
  assert.equal(isComfyuiWorkflowV04(v04), true);
  assert.equal(isComfyuiWorkflowV1(v1), true);
  assert.equal(isSupportedComfyuiWorkflow(v04), true);
  assert.equal(isSupportedComfyuiWorkflow(v1), true);

  assert.equal(isComfyuiWorkflowV04(workflowV04({ groups: undefined, config: null, extra: null, models: undefined })), true);
  assert.equal(isComfyuiWorkflowV1(workflowV1({ groups: undefined, links: undefined, reroutes: undefined, extra: undefined, models: undefined })), true);
  assert.equal(isComfyuiWorkflowV1(workflowV1({
    nodes: [node({ inputs: [inputPort({ link: undefined, links: undefined, slot_index: undefined })], outputs: undefined })],
    links: [{ id: 1, origin_id: 1, origin_slot: 'out', target_id: '2', target_slot: 0, type: 'IMAGE' }],
    reroutes: [{ id: 1, pos: [0, 0], linkIds: null }]
  })), true);
});

test('ComfyUI Workflow 0.4 校验器拒绝每个必需属性和嵌套端口的错误类型', () => {
  const invalid = [
    null,
    workflowV04({ version: 1 }),
    workflowV04({ last_node_id: {} }),
    workflowV04({ last_link_id: Number.NaN }),
    workflowV04({ nodes: {} }),
    mutate(workflowV04(), (value) => { value.nodes[0].id = {}; }),
    mutate(workflowV04(), (value) => { value.nodes[0].type = 1; }),
    mutate(workflowV04(), (value) => { value.nodes[0].pos = [0]; }),
    mutate(workflowV04(), (value) => { value.nodes[0].size = null; }),
    mutate(workflowV04(), (value) => { value.nodes[0].flags = []; }),
    mutate(workflowV04(), (value) => { value.nodes[0].order = Number.POSITIVE_INFINITY; }),
    mutate(workflowV04(), (value) => { value.nodes[0].mode = '0'; }),
    mutate(workflowV04(), (value) => { value.nodes[0].properties = null; }),
    mutate(workflowV04(), (value) => { value.nodes[0].inputs = {}; }),
    mutate(workflowV04(), (value) => { value.nodes[0].outputs = {}; }),
    ...[
      { name: 1 },
      { type: {} },
      { link: false },
      { links: [Number.NaN] },
      { slot_index: {} }
    ].map((portChange) => mutate(workflowV04(), (value) => { value.nodes[0].inputs[0] = inputPort(portChange); }))
  ];
  for (const value of invalid) assert.equal(isComfyuiWorkflowV04(value), false);
});

test('ComfyUI Workflow 0.4 校验器拒绝错误的旧链接、分组、配置和模型描述', () => {
  const invalidLinks = [
    {}, [1, 1, 0, 2, 0], ['1', 1, 0, 2, 0, 'IMAGE'],
    [1, {}, 0, 2, 0, 'IMAGE'], [1, 1, {}, 2, 0, 'IMAGE'],
    [1, 1, 0, {}, 0, 'IMAGE'], [1, 1, 0, 2, {}, 'IMAGE'], [1, 1, 0, 2, 0, {}]
  ];
  const invalid = [
    workflowV04({ links: {} }),
    ...invalidLinks.map((link) => workflowV04({ links: [link] })),
    workflowV04({ groups: {} }),
    workflowV04({ groups: [null] }),
    workflowV04({ groups: [{ title: 1, bounding: [0, 1, 2, 3] }] }),
    workflowV04({ groups: [{ title: 'Group', bounding: {} }] }),
    workflowV04({ groups: [{ title: 'Group', bounding: [0, 1, 2] }] }),
    workflowV04({ groups: [{ title: 'Group', bounding: [0, 1, 2, Number.NaN] }] }),
    workflowV04({ config: [] }),
    workflowV04({ extra: [] }),
    workflowV04({ models: {} }),
    workflowV04({ models: [model({ url: 'not a URL' })] }),
    workflowV04({ models: [model({ name: 1 })] }),
    workflowV04({ models: [model({ url: 1 })] }),
    workflowV04({ models: [model({ directory: 1 })] }),
    workflowV04({ models: [model({ hash: 1 })] }),
    workflowV04({ models: [model({ hash_type: 1 })] }),
    workflowV04({ models: [model({ unknown: true })] })
  ];
  for (const value of invalid) assert.equal(isComfyuiWorkflowV04(value), false);
});

test('ComfyUI Workflow 1.0 校验器拒绝错误的顶层属性、链接和重路由结构', () => {
  const invalidLinks = [
    null,
    { id: '1', origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'IMAGE' },
    { id: 1, origin_id: {}, origin_slot: 0, target_id: 2, target_slot: 0, type: 'IMAGE' },
    { id: 1, origin_id: 1, origin_slot: {}, target_id: 2, target_slot: 0, type: 'IMAGE' },
    { id: 1, origin_id: 1, origin_slot: 0, target_id: {}, target_slot: 0, type: 'IMAGE' },
    { id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: {}, type: 'IMAGE' },
    { id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: {} },
    { id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'IMAGE', parentId: '4' }
  ];
  const invalidReroutes = [
    null,
    { id: '1', pos: [0, 0] },
    { id: 1, pos: [0] },
    { id: 1, pos: [0, 0], parentId: '2' },
    { id: 1, pos: [0, 0], linkIds: {} },
    { id: 1, pos: [0, 0], linkIds: [Number.NaN] }
  ];
  const invalid = [
    workflowV1({ version: 0.4 }),
    workflowV1({ state: [] }),
    workflowV1({ nodes: {} }),
    workflowV1({ config: [] }),
    workflowV1({ groups: {} }),
    workflowV1({ links: {} }),
    ...invalidLinks.map((link) => workflowV1({ links: [link] })),
    workflowV1({ reroutes: {} }),
    ...invalidReroutes.map((reroute) => workflowV1({ reroutes: [reroute] })),
    workflowV1({ extra: [] }),
    workflowV1({ models: {} })
  ];
  for (const value of invalid) assert.equal(isComfyuiWorkflowV1(value), false);
  for (const value of [undefined, null, [], { version: 2 }, { version: '1' }]) {
    assert.equal(isSupportedComfyuiWorkflow(value), false);
  }
});
