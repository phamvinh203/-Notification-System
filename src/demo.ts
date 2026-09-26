// Demo end-to-end (spec mục 8). Chạy khi server đang chạy: npm run dev (terminal 1) → npm run demo (terminal 2).
const BASE = process.env.API_URL ?? 'http://localhost:3000';

interface EnqueueRes { id: string; status: string }

async function send(payload: Record<string, unknown>): Promise<EnqueueRes> {
  const res = await fetch(`${BASE}/notifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST fail ${res.status}: ${await res.text()}`);
  return res.json() as Promise<EnqueueRes>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`Demo gọi API tại ${BASE} — gợi ý: đặt FAIL_RATE=0.5 khi chạy server để thấy retry rõ hơn\n`);

  // 1. Gửi ngay 3 kênh
  const ids: string[] = [];
  const targets = [
    { channel: 'email', recipient: 'student@example.com', subject: 'Demo email', body: 'Xin chào từ demo script' },
    { channel: 'push', recipient: 'device-token-abc-123', body: 'Bạn có 1 thông báo mới' },
    { channel: 'sms', recipient: '+84901234567', body: 'Ma xac minh: 246810' },
  ] as const;
  for (const t of targets) {
    const r = await send(t);
    ids.push(r.id);
    console.log(`[${t.channel}] id=${r.id} status=${r.status}`);
  }

  // 2. Schedule 1 email sau 30s
  const sendAt = new Date(Date.now() + 30_000).toISOString();
  const sched = await send({ channel: 'email', recipient: 'scheduled@example.com', subject: 'Demo scheduled', body: 'Gửi sau 30s', sendAt });
  console.log(`[email scheduled] id=${sched.id} status=${sched.status} (sẽ chạy lúc ${sendAt})`);

  // 3. Đợi worker xử lý rồi in timeline
  console.log('\nĐợi 12s cho worker xử lý 3 job đầu...');
  await sleep(12_000);
  for (const id of ids) {
    const res = await fetch(`${BASE}/notifications/${id}`);
    const { notification, events } = await res.json() as { notification: { status: string }; events: { event: string; detail: string | null }[] };
    console.log(`\n--- ${id} → ${notification.status}`);
    for (const e of events) console.log(`  ${e.event}${e.detail ? ` (${e.detail})` : ''}`);
  }

  // 4. Hướng xem trực quan
  console.log(`\nJob scheduled còn lại — xem trên Bull Board: ${BASE}/admin/queues`);
  console.log('Xem timeline job scheduled sau khi nó chạy: curl ' + `${BASE}/notifications/${sched.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
