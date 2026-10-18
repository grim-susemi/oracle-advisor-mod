import { runAcceptanceCase } from './acceptance.mjs';

export const run = values => runAcceptanceCase({ ...values, case: 'acceptance-oracle-down' });
