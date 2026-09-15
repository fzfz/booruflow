const argumentsAfterCommand = process.argv.slice(2);

if (argumentsAfterCommand.length === 0) {
  process.stderr.write('Provide at least one job result as job=result\n');
  process.exitCode = 1;
} else {
  const invalid = [];
  for (const argument of argumentsAfterCommand) {
    const separator = argument.indexOf('=');
    const job = separator > 0 ? argument.slice(0, separator) : argument;
    const result = separator > 0 ? argument.slice(separator + 1) : '';
    if (result !== 'success') invalid.push(`${job}=${result || 'missing'}`);
  }
  if (invalid.length > 0) {
    process.stderr.write(`Required jobs did not succeed: ${invalid.join(', ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Required jobs succeeded: ${argumentsAfterCommand.map((value) => value.slice(0, value.indexOf('='))).join(', ')}\n`);
  }
}
