// Node's reporter event stream supplies execution identities, not TAP prose.
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (!['test:enqueue', 'test:pass', 'test:fail'].includes(type)) continue;
    yield `ORACLE_VERDICT_TEST ${JSON.stringify({
      type, name: data.name, file: data.file, line: data.line, column: data.column,
      nesting: data.nesting, skipped: data.skip ?? false, todo: data.todo ?? false,
      error: data.details?.error ? {
        message: data.details.error.message, stack: data.details.error.stack,
      } : null,
    })}\n`;
  }
}
