export function parseLoraTriggerWords(value) {
  if (typeof value !== 'string') throw new TypeError('触发词输入必须是文本。');
  return Object.freeze(value
    .split(/\r?\n/u)
    .map((triggerWord) => triggerWord.trim())
    .filter((triggerWord) => triggerWord.length > 0));
}

export function parseLoraWeight(value) {
  if (typeof value !== 'string') throw new TypeError('默认模型权重输入必须是文本。');
  const weightText = value.trim();
  if (weightText.length === 0) throw new TypeError('默认模型权重不能为空。');
  const weight = Number(weightText);
  if (!Number.isFinite(weight)) throw new TypeError('默认模型权重必须是有限数值。');
  return weight;
}
