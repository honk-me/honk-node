// Compile-only checks of the public types (ESM consumer). Not executed.
import { Honk, HonkError, HonkQuotaError, Severity, type Action, type Message, type SendResult } from 'honk-me';

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
const actions: Action[] = [{ title: 'Reply', url: 'mailto:emily@example.com' }, { title: 'Call', url: 'tel:+15550134' }];
void honk.send({ message: 'Emily asked for a quote', actions });
void honk.loud('Disk 91%', '/var', { actions: [{ title: 'Open', url: 'https://x' }] as const });
// @ts-expect-error an action needs a url
const noUrl: Message = { message: 'x', actions: [{ title: 'Call' }] };
void noUrl;
try {
  await honk.info('t', 'm');
} catch (e) {
  if (e instanceof HonkQuotaError) e.retryAfter?.toFixed();
  if (e instanceof HonkError && e.kind === 'timeout') e.idempotencyKey?.length;
}
