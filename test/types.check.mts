// Compile-only checks of the public types (ESM consumer). Not executed.
import { Honk, HonkError, HonkQuotaError, Severity, type Message, type SendResult } from 'honk-me';

const honk = new Honk({ url: 'https://honk.example.com', key: 'honk_x', defaults: { source: 'api' } });
const msg: Message = { message: 'x', severity: 'error', groupKey: 'g', metadata: { a: 1, b: 'c', d: true } };
const res: Promise<SendResult> = honk.send(msg, { idempotencyKey: 'k' });
void res;
void honk.problem('g', 't', 'm', { url: 'https://x', idempotencyKey: 'k' });
const horns: Message[] = [{ message: 'x', severity: 'loud' }, { message: 'x', severity: 'BLAST' }, { message: 'x', severity: Severity.Long }];
const canonical: Severity = Severity.Beep;
void horns;
void canonical;
void honk.loud('Disk 91%', '/var on app-01');
// @ts-expect-error severity is an enum
const bad: Message = { message: 'x', severity: 'fatal' };
void bad;
try {
  await honk.info('t', 'm');
} catch (e) {
  if (e instanceof HonkQuotaError) e.retryAfter?.toFixed();
  if (e instanceof HonkError && e.kind === 'timeout') e.idempotencyKey?.length;
}
