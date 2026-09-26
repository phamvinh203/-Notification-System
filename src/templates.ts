import Handlebars from 'handlebars';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// noEscape: nội dung là plain text (SMS/email), không phải HTML
const registry = new Map<string, Handlebars.TemplateDelegate>();

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
for (const file of readdirSync(dir)) {
  if (file.endsWith('.hbs')) {
    const name = file.replace(/\.hbs$/, '');
    registry.set(name, Handlebars.compile(readFileSync(join(dir, file), 'utf8'), { noEscape: true }));
  }
}

export function listTemplates(): string[] {
  return [...registry.keys()].sort();
}

/** Render template theo tên; trả null nếu template không tồn tại */
export function renderTemplate(name: string, params: Record<string, unknown> = {}): string | null {
  const t = registry.get(name);
  return t ? t(params) : null;
}
