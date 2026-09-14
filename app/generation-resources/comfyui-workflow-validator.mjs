function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isIdentifier(value) {
  return Number.isInteger(value) || typeof value === 'string';
}

function isPortType(value) {
  return typeof value === 'string'
    || isNumber(value)
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function isPoint(value) {
  if (Array.isArray(value)) return value.length === 2 && value.every(isNumber);
  return isObject(value) && isNumber(value[0]) && isNumber(value[1]);
}

function validPort(port) {
  return isObject(port)
    && typeof port.name === 'string'
    && isPortType(port.type)
    && (port.link === undefined || port.link === null || isNumber(port.link))
    && (port.links === undefined || port.links === null || (Array.isArray(port.links) && port.links.every(isNumber)))
    && (port.slot_index === undefined || isIdentifier(port.slot_index));
}

function validNode(node) {
  return isObject(node)
    && isIdentifier(node.id)
    && typeof node.type === 'string'
    && isPoint(node.pos)
    && isPoint(node.size)
    && isObject(node.flags)
    && isNumber(node.order)
    && isNumber(node.mode)
    && isObject(node.properties)
    && (node.inputs === undefined || (Array.isArray(node.inputs) && node.inputs.every(validPort)))
    && (node.outputs === undefined || (Array.isArray(node.outputs) && node.outputs.every(validPort)));
}

function validLink(link) {
  return isObject(link)
    && isNumber(link.id)
    && isIdentifier(link.origin_id)
    && isIdentifier(link.origin_slot)
    && isIdentifier(link.target_id)
    && isIdentifier(link.target_slot)
    && isPortType(link.type)
    && (link.parentId === undefined || isNumber(link.parentId));
}

function validLegacyLink(link) {
  return Array.isArray(link)
    && link.length === 6
    && isNumber(link[0])
    && isIdentifier(link[1])
    && isIdentifier(link[2])
    && isIdentifier(link[3])
    && isIdentifier(link[4])
    && isPortType(link[5]);
}

function validGroup(group) {
  return isObject(group)
    && typeof group.title === 'string'
    && Array.isArray(group.bounding)
    && group.bounding.length === 4
    && group.bounding.every(isNumber);
}

function validReroute(reroute) {
  return isObject(reroute)
    && isNumber(reroute.id)
    && isPoint(reroute.pos)
    && (reroute.parentId === undefined || isNumber(reroute.parentId))
    && (reroute.linkIds === undefined || reroute.linkIds === null || (Array.isArray(reroute.linkIds) && reroute.linkIds.every(isNumber)));
}

function validModel(model) {
  const allowedKeys = new Set(['name', 'url', 'hash', 'hash_type', 'directory']);
  let parsedUrl;
  try {
    parsedUrl = new URL(model?.url);
  } catch {
    return false;
  }
  return isObject(model)
    && typeof model.name === 'string'
    && typeof model.url === 'string'
    && parsedUrl.protocol.length > 1
    && typeof model.directory === 'string'
    && (model.hash === undefined || typeof model.hash === 'string')
    && (model.hash_type === undefined || typeof model.hash_type === 'string')
    && Object.keys(model).every((key) => allowedKeys.has(key));
}

export const COMFYUI_WORKFLOW_FORMAT = Object.freeze({
  versions: Object.freeze({ v0_4: 0.4, v1_0: 1 }),
  errorDetails: Object.freeze({ field: 'template_json', supported_versions: Object.freeze(['0.4', '1.0']) }),
  validationMessage: 'template_json must satisfy ComfyUI Workflow JSON 0.4 or 1.0'
});

export function isComfyuiWorkflowV04(value) {
  return isObject(value)
    && value.version === COMFYUI_WORKFLOW_FORMAT.versions.v0_4
    && isIdentifier(value.last_node_id)
    && isNumber(value.last_link_id)
    && Array.isArray(value.nodes)
    && value.nodes.every(validNode)
    && Array.isArray(value.links)
    && value.links.every(validLegacyLink)
    && (value.groups === undefined || (Array.isArray(value.groups) && value.groups.every(validGroup)))
    && (value.config === undefined || value.config === null || isObject(value.config))
    && (value.extra === undefined || value.extra === null || isObject(value.extra))
    && (value.models === undefined || (Array.isArray(value.models) && value.models.every(validModel)));
}

/**
 * Structural validation for persisted ComfyUI Workflow JSON 1.0.
 * It deliberately does not resolve nodes, links, or models.
 */
export function isComfyuiWorkflowV1(value) {
  return isObject(value)
    && value.version === COMFYUI_WORKFLOW_FORMAT.versions.v1_0
    && isObject(value.state)
    && Array.isArray(value.nodes)
    && value.nodes.every(validNode)
    && (value.config === undefined || value.config === null || isObject(value.config))
    && (value.groups === undefined || (Array.isArray(value.groups) && value.groups.every(validGroup)))
    && (value.links === undefined || (Array.isArray(value.links) && value.links.every(validLink)))
    && (value.reroutes === undefined || (Array.isArray(value.reroutes) && value.reroutes.every(validReroute)))
    && (value.extra === undefined || value.extra === null || isObject(value.extra))
    && (value.models === undefined || (Array.isArray(value.models) && value.models.every(validModel)));
}

export function isSupportedComfyuiWorkflow(value) {
  if (!isObject(value)) return false;
  if (value.version === COMFYUI_WORKFLOW_FORMAT.versions.v0_4) return isComfyuiWorkflowV04(value);
  if (value.version === COMFYUI_WORKFLOW_FORMAT.versions.v1_0) return isComfyuiWorkflowV1(value);
  return false;
}
