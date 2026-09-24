#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseDiagnosticRequest } from '../lib/addressed-tool-diagnostics.mjs';
import {
  diagnosticOwnerAvailable,
  readDiagnosticDescriptor,
  requestDiagnostic,
} from '../lib/tool-diagnostic-endpoint.mjs';

// This is a host operation. It never creates a supervisor, writes a store or
// accepts authority/cwd/commands from an executor's request.
try {
  const [operation, ...args] = process.argv.slice(2);
  const expected = operation === 'submit' ? '--request' : '--request-id';
  if (
    !['submit', 'get'].includes(operation) ||
    args.length !== 4 ||
    args[0] !== '--endpoint' ||
    args[2] !== expected
  )
    throw new Error(
      'usage: submit|get --endpoint <descriptor.json> --request <request.json>|--request-id <id>',
    );
  const descriptor = readDiagnosticDescriptor(args[1]);
  if (!(await diagnosticOwnerAvailable(descriptor))) throw new Error('owner-unavailable');
  const message =
    operation === 'submit'
      ? {
          operation,
          request: parseDiagnosticRequest(JSON.parse(readFileSync(args[3], 'utf8'))).request,
        }
      : { operation, requestId: args[3] };
  const result = await requestDiagnostic(descriptor, message);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, reason: error.message })}\n`);
  process.exitCode = 1;
}
