import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function text(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

function secondsOf(source: string, name: string): number[] {
  const pattern = new RegExp(`^\\s*${name}\\s+(\\d+)(ms|s|m)?\\s*;`, 'gm');
  return [...source.matchAll(pattern)].map((match) => {
    const value = Number(match[1]);
    const unit = match[2] ?? 's';
    if (unit === 'ms') return value / 1000;
    if (unit === 'm') return value * 60;
    return value;
  });
}

describe('ingress nginx configuration', () => {
  const nginx = text('docker/nginx/nginx.conf');
  const allow = text('docker/nginx/admin-allowlist.conf');
  const compose = text('docker-compose.yml');
  const install = text('docker/nginx/install-certs.sh');
  const entry = text('docker/nginx/entrypoint.sh');
  const reload = text('docker/nginx/reload-ingress.sh');
  const check = text('docker/nginx/check-certificate.sh');

  it('terminates TLS 1.2 and TLS 1.3 with the configured certificate paths', () => {
    const protocols = nginx.match(/^\s*ssl_protocols\s+([^;]+);/m);
    expect(protocols?.[1]?.trim().split(/\s+/).sort()).toEqual(['TLSv1.2', 'TLSv1.3']);
    expect(nginx).toMatch(/ssl_certificate\s+\/etc\/nginx\/tls\/server\.crt\s*;/);
    expect(nginx).toMatch(/ssl_certificate_key\s+\/etc\/nginx\/tls\/server\.key\s*;/);
    expect(nginx).toMatch(/ssl_trusted_certificate\s+\/etc\/nginx\/tls\/ca\.crt\s*;/);
    expect(nginx).not.toMatch(/ssl_client_certificate/);
    expect(install).toContain('/etc/nginx/ingress/server.crt');
    expect(install).toContain('/etc/nginx/ingress/server.key');
    expect(install).toContain('/etc/nginx/ingress/ca.crt');
    expect(install).toContain('/etc/nginx/tls/server.crt');
    expect(entry).toContain('/usr/local/bin/install-certs');
    expect(reload).toContain('/usr/local/bin/install-certs');
    expect(reload).toContain('nginx -s reload');
    expect(install).not.toMatch(/\bcat\b/);
    expect(check).toContain('certificate valid');
    expect(check).toContain('certificate expired');
    expect(check).toContain('PRIVATE KEY');
    expect(check).not.toMatch(/\bcat\b/);
  });

  it('forwards tenant headers and overwrites forwarding headers', () => {
    expect(nginx).toMatch(/proxy_set_header\s+X-Tenant-Id\s+\$http_x_tenant_id\s*;/);
    expect(nginx).toMatch(/proxy_set_header\s+Authorization\s+\$http_authorization\s*;/);
    expect(nginx).toMatch(/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr\s*;/);
    expect(nginx).toMatch(/proxy_set_header\s+X-Real-IP\s+\$remote_addr\s*;/);
    expect(nginx).toMatch(/proxy_set_header\s+X-Forwarded-Proto\s+https\s*;/);
    expect(nginx).toMatch(/proxy_set_header\s+Forwarded\s+"[^"]*\$remote_addr[^"]*"\s*;/);
    expect(nginx).not.toContain('$proxy_add_x_forwarded_for');
    expect(nginx).not.toContain('$http_x_forwarded_for');
    expect(nginx).not.toContain('$http_forwarded');
  });

  it('does not buffer or compress an event stream and keeps long timeouts', () => {
    expect(nginx).toContain('text/event-stream');
    expect(nginx).toMatch(/proxy_buffering\s+off\s*;/);
    expect(nginx).toMatch(/gzip\s+off\s*;/);
    expect(nginx).toMatch(/proxy_max_temp_file_size\s+0\s*;/);
    expect(nginx).toMatch(/proxy_ignore_client_abort\s+off\s*;/);
    expect(Math.max(...secondsOf(nginx, 'proxy_read_timeout')) * 1000).toBeGreaterThan(600_000);
    expect(Math.max(...secondsOf(nginx, 'proxy_send_timeout')) * 1000).toBeGreaterThan(600_000);
    expect(Math.min(...secondsOf(nginx, 'keepalive_timeout')) * 1000).toBeGreaterThanOrEqual(620_000);
  });

  it('does not retry, limits the body, and gates admin and mcp routes', () => {
    expect(nginx).toMatch(/proxy_next_upstream\s+off\s*;/);
    expect(nginx).not.toMatch(/proxy_next_upstream\s+(error|timeout|http_|non_idempotent)/);
    expect(nginx).toMatch(/client_max_body_size\s+1m\s*;/);
    expect(nginx).toMatch(/location\s+\/internal\/\s*\{/);
    expect(nginx).toContain('include /etc/nginx/admin-allowlist.conf');
    expect(allow).toMatch(/^allow\s+\S+/m);
    expect(allow).toMatch(/^deny\s+all\s*;/m);
    expect(allow).not.toMatch(/^allow\s+all\s*;/m);
    expect(nginx).toMatch(/location\s+\/mcp\s*\{/);
    expect(nginx).toMatch(/if\s+\(\$http_x_tenant_id\s+=\s+""\)/);
    expect(nginx).toMatch(/if\s+\(\$http_authorization\s+=\s+""\)/);
    expect(nginx).toMatch(/return\s+401/);
    expect(nginx).not.toMatch(/proxy_pass\s+https?:\/\/\$/);
    expect(nginx).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it('publishes only port 443 and keeps the app command', () => {
    const published = [...compose.matchAll(/^\s+-\s+"(\d+:\d+)"/gm)].map((match) => match[1]);
    expect(published).toEqual(['443:443']);
    expect(compose).not.toContain('"8080:8080"');
    expect(compose).not.toContain('"80:80"');
    expect(text('Dockerfile')).toContain('CMD ["node", "dist/index.js"]');
    expect(text('.gitignore')).toContain('config/ingress/');
    expect(text('.dockerignore')).toContain('config/ingress');
  });
});
