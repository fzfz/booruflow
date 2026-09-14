function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resolveJsonPointer(value, pointer) {
  if (typeof pointer !== 'string') throw new TypeError('JSON pointer must be a string');
  if (pointer === '' || pointer === '/') return value;
  if (!pointer.startsWith('/')) throw new TypeError(`unsupported JSON pointer #${pointer}`);
  let current = value;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      throw new TypeError(`unresolved JSON pointer #${pointer}`);
    }
    current = current[segment];
  }
  return current;
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function typeMatches(value, type) {
  if (type === 'object') return isObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return false;
}

function isRfc3339DateTime(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText = '00', offsetMinuteText = '00'] = match;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText
  ].map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

function isUri(value) {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$/u.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
  ) return false;
  const rawUri = /^(?:https?):\/\/[^/?#]+(?<suffix>.*)$/iu.exec(value);
  if (!rawUri || /[\[\]]/u.test(rawUri.groups.suffix)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

function referenceResult(options, reference) {
  if (typeof options.resolveReference !== 'function') {
    throw new TypeError('JSON Schema validation requires a resolveReference callback');
  }
  const result = options.resolveReference(reference, options.context);
  if (!isObject(result) || !Object.hasOwn(result, 'schema')) {
    throw new TypeError('resolveReference must return {schema, context}');
  }
  return { schema: result.schema, context: result.context ?? options.context };
}

function withContext(options, context) {
  return context === options.context ? options : { ...options, context };
}

function propertyNames(schema, options, names = new Set(), seen = new Set()) {
  if (!isObject(schema)) return names;
  if (typeof schema.$ref === 'string') {
    const key = `${String(options.context ?? '')}#${schema.$ref}`;
    if (!seen.has(key)) {
      seen.add(key);
      const resolved = referenceResult(options, schema.$ref);
      propertyNames(resolved.schema, withContext(options, resolved.context), names, seen);
    }
    const siblings = { ...schema };
    delete siblings.$ref;
    propertyNames(siblings, options, names, seen);
  }
  if (isObject(schema.properties)) Object.keys(schema.properties).forEach((name) => names.add(name));
  if (Array.isArray(schema.allOf)) schema.allOf.forEach((child) => propertyNames(child, options, names, seen));
  return names;
}

function childErrors(value, schema, options, instancePath, seenRefs) {
  return validationErrors(value, schema, options, instancePath, seenRefs);
}

export function validationErrors(value, schema, options, instancePath = '$', seenRefs = new Set()) {
  if (schema === true) return [];
  if (schema === false) return [`${instancePath} is rejected by false schema`];
  if (!isObject(schema)) return [`${instancePath} has an invalid schema node`];
  if (typeof schema.$ref === 'string') {
    const key = `${String(options.context ?? '')}#${schema.$ref}`;
    if (seenRefs.has(key)) return [];
    const nextSeen = new Set(seenRefs).add(key);
    const resolved = referenceResult(options, schema.$ref);
    const resolvedOptions = withContext(options, resolved.context);
    const errors = childErrors(value, resolved.schema, resolvedOptions, instancePath, nextSeen);
    const siblings = { ...schema };
    delete siblings.$ref;
    return [...errors, ...childErrors(value, siblings, options, instancePath, seenRefs)];
  }

  const errors = [];
  if (Object.hasOwn(schema, 'const') && !deepEqual(value, schema.const)) errors.push(`${instancePath} must equal its const value`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(value, item))) errors.push(`${instancePath} must be an allowed enum value`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) errors.push(`${instancePath} must have type ${types.join(' or ')}`);
  }
  if (Array.isArray(schema.allOf)) schema.allOf.forEach((child) => errors.push(...childErrors(value, child, options, instancePath, seenRefs)));
  if (Array.isArray(schema.anyOf)) {
    const branchErrors = schema.anyOf.map((child) => childErrors(value, child, options, instancePath, seenRefs));
    if (!branchErrors.some((branch) => branch.length === 0)) errors.push(`${instancePath} must match at least one anyOf branch`, ...branchErrors.flat());
  }
  if (Array.isArray(schema.oneOf)) {
    const branchErrors = schema.oneOf.map((child) => childErrors(value, child, options, instancePath, seenRefs));
    const matches = branchErrors.filter((branch) => branch.length === 0).length;
    if (matches !== 1) {
      errors.push(`${instancePath} must match exactly one oneOf branch`);
      if (matches === 0) errors.push(...branchErrors.flat());
    }
  }
  if (schema.not && childErrors(value, schema.not, options, instancePath, seenRefs).length === 0) errors.push(`${instancePath} must not match the not schema`);
  if (schema.if) {
    const conditionMatches = childErrors(value, schema.if, options, instancePath, seenRefs).length === 0;
    if (conditionMatches && schema.then) errors.push(...childErrors(value, schema.then, options, instancePath, seenRefs));
    if (!conditionMatches && schema.else) errors.push(...childErrors(value, schema.else, options, instancePath, seenRefs));
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${instancePath} is below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${instancePath} is above maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${instancePath} is not above exclusiveMinimum`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${instancePath} is not below exclusiveMaximum`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${instancePath} is shorter than minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${instancePath} is longer than maxLength`);
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern, 'u')).test(value)) errors.push(`${instancePath} fails pattern`);
    if (schema.format === 'date-time' && !isRfc3339DateTime(value)) errors.push(`${instancePath} fails date-time format`);
    if (schema.format === 'uri' && !isUri(value)) errors.push(`${instancePath} fails uri format`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${instancePath} has fewer than minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${instancePath} has more than maxItems`);
    if (schema.uniqueItems && new Set(value.map((item) => canonicalJson(item))).size !== value.length) errors.push(`${instancePath} has duplicate items`);
    if (Array.isArray(schema.prefixItems)) schema.prefixItems.forEach((child, index) => {
      if (index < value.length) errors.push(...childErrors(value[index], child, options, `${instancePath}[${index}]`, seenRefs));
    });
    if (schema.items === false && Array.isArray(schema.prefixItems) && value.length > schema.prefixItems.length) errors.push(`${instancePath} has disallowed trailing items`);
    if (schema.items && schema.items !== false) {
      const start = Array.isArray(schema.prefixItems) ? schema.prefixItems.length : 0;
      for (let index = start; index < value.length; index += 1) errors.push(...childErrors(value[index], schema.items, options, `${instancePath}[${index}]`, seenRefs));
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) errors.push(`${instancePath} has fewer than minProperties`);
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) errors.push(`${instancePath} has more than maxProperties`);
    for (const name of schema.required ?? []) if (!Object.hasOwn(value, name)) errors.push(`${instancePath}.${name} is required`);
    const known = propertyNames(schema, options);
    if (schema.additionalProperties === false || schema.unevaluatedProperties === false) {
      for (const name of Object.keys(value)) if (!known.has(name)) errors.push(`${instancePath}.${name} is not allowed`);
    }
    if (isObject(schema.additionalProperties)) {
      for (const name of Object.keys(value)) if (!known.has(name)) errors.push(...childErrors(value[name], schema.additionalProperties, options, `${instancePath}.${name}`, seenRefs));
    }
    if (isObject(schema.unevaluatedProperties)) {
      for (const name of Object.keys(value)) if (!known.has(name)) errors.push(...childErrors(value[name], schema.unevaluatedProperties, options, `${instancePath}.${name}`, seenRefs));
    }
    for (const [name, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) errors.push(...childErrors(value[name], child, options, `${instancePath}.${name}`, seenRefs));
    }
  }
  return errors;
}
