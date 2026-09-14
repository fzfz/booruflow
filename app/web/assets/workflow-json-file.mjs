export function formatWorkflowJsonFile(fileName, fileText) {
  if (typeof fileName !== 'string' || !fileName.toLocaleLowerCase('en-US').endsWith('.json')) {
    throw new Error(`文件“${fileName}”不是 .json 文件。`);
  }
  try {
    return JSON.stringify(JSON.parse(fileText), null, 2);
  } catch (error) {
    throw new Error(`文件“${fileName}”包含无效 JSON：${error.message}`);
  }
}
