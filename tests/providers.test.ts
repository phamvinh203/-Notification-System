import { afterEach, describe, expect, it, vi } from 'vitest';

// Test adapter thật (resend/twilio) OFFLINE — mock global fetch, resetModules để config đọc lại env
async function loadProvider(path: string, env: Record<string, string>) {
  vi.resetModules();
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return await import(path);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const fetchMock = (status: number, body: unknown) =>
  vi.fn(async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('provider thật — resend (email) [offline, fetch mock]', () => {
  it('gửi đúng payload lên API Resend và trả về info', async () => {
    const f = fetchMock(200, { id: 're-test-123' });
    vi.stubGlobal('fetch', f);
    const { emailProvider } = await loadProvider('../src/providers/email.js', {
      EMAIL_MODE: 'resend',
      RESEND_API_KEY: 're_key_test',
      RESEND_FROM: 'Notification <onboarding@resend.dev>',
    });

    const result = await emailProvider.send({
      to: 'real@inbox.dev',
      subject: 'Xin chào',
      body: 'email thật',
    });

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_key_test');
    const payload = JSON.parse(init.body as string);
    expect(payload.to).toEqual(['real@inbox.dev']);
    expect(payload.subject).toBe('Xin chào');
    expect(result).toEqual({ info: 'email thật qua Resend (id: re-test-123)' });
  });

  it('API trả lỗi → throw (worker sẽ retry)', async () => {
    vi.stubGlobal('fetch', fetchMock(422, { message: 'validation_error' }));
    const { emailProvider } = await loadProvider('../src/providers/email.js', {
      EMAIL_MODE: 'resend',
      RESEND_API_KEY: 're_key_test',
      RESEND_FROM: 'Notification <onboarding@resend.dev>',
    });

    await expect(emailProvider.send({ to: 'a@b.c', body: 'x' })).rejects.toThrow(/\[resend\] API trả 422/);
  });

  it('thiếu API key → throw rõ ràng', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { emailProvider } = await loadProvider('../src/providers/email.js', { EMAIL_MODE: 'resend' });

    await expect(emailProvider.send({ to: 'a@b.c', body: 'x' })).rejects.toThrow(/thiếu RESEND_API_KEY/);
  });
});

describe('provider thật — twilio (sms) [offline, fetch mock]', () => {
  it('POST form-urlencoded với Basic auth đúng và trả info', async () => {
    const f = fetchMock(201, { sid: 'SM-test-456' });
    vi.stubGlobal('fetch', f);
    const { smsProvider } = await loadProvider('../src/providers/sms.js', {
      SMS_MODE: 'twilio',
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'tok',
      TWILIO_FROM: '+15550001111',
    });

    const result = await smsProvider.send({ to: '+84901234567', body: 'Ma xac minh 246810' });

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Basic ' + Buffer.from('AC123:tok').toString('base64'),
    );
    const body = init.body as URLSearchParams;
    expect(body.get('To')).toBe('+84901234567');
    expect(body.get('From')).toBe('+15550001111');
    expect(body.get('Body')).toBe('Ma xac minh 246810');
    expect(result).toEqual({ info: 'SMS thật qua Twilio (sid: SM-test-456)' });
  });

  it('thiếu credential → throw rõ ràng', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { smsProvider } = await loadProvider('../src/providers/sms.js', { SMS_MODE: 'twilio' });

    await expect(smsProvider.send({ to: '+8490', body: 'x' })).rejects.toThrow(/\[twilio\] thiếu/);
  });
});

describe('webhook — chữ ký HMAC [offline, fetch mock]', () => {
  it('có secret → header X-Notification-Signature đúng format, HMAC tái kiểm chứng được', async () => {
    const f = fetchMock(200, { ok: true });
    vi.stubGlobal('fetch', f);
    const { webhookProvider, signWebhookPayload } = await loadProvider('../src/providers/webhook.js', {
      WEBHOOK_SIGNING_SECRET: 'whsec_test_123',
    });

    const result = await webhookProvider.send({ to: 'https://receiver.dev/hook', subject: 'S', body: 'B' });

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://receiver.dev/hook');
    const sig = (init.headers as Record<string, string>)['x-notification-signature'];
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig ?? '');
    expect(m).toBeTruthy(); // format Stripe-style: t=<unix>,v1=<hmac hex>
    // receiver tái tính HMAC của "<t>.<raw body>" phải khớp v1
    expect(signWebhookPayload('whsec_test_123', Number(m![1]), init.body as string)).toBe(m![2]);
    expect(JSON.parse(init.body as string)).toEqual({ subject: 'S', body: 'B' });
    expect(result).toEqual({ info: 'signed (HMAC v1)' });
  });

  it('không secret → không có header chữ ký (backward compatible)', async () => {
    const f = fetchMock(200, { ok: true });
    vi.stubGlobal('fetch', f);
    const { webhookProvider } = await loadProvider('../src/providers/webhook.js', {});

    const result = await webhookProvider.send({ to: 'https://receiver.dev/hook', body: 'x' });

    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-notification-signature']).toBeUndefined();
    expect(result).toBeUndefined(); // không có info
  });
});
