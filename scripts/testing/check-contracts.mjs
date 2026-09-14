import { verifyAuthoritativeContracts } from '../../app/contracts/verify-contracts.mjs';

try {
  const result = verifyAuthoritativeContracts();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 1;
}
