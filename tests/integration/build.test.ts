import { cp, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { build } from 'astro';
import { beforeAll, describe, expect, it } from 'vitest';

import type { YandexCloudManifestV1 } from '../../packages/adapter/src/types.js';

const fixtures = resolve(import.meta.dirname, '../fixtures');
const execFileAsync = promisify(execFile);

async function layout(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? (await layout(path)).map((child) => `${entry.name}/${child}`)
        : [entry.name];
    }),
  );
  return paths.flat().sort();
}

async function manifest(fixture: string): Promise<YandexCloudManifestV1> {
  return JSON.parse(
    await readFile(join(fixtures, fixture, 'dist/yandex-cloud.json'), 'utf8'),
  ) as YandexCloudManifestV1;
}

describe.sequential('Astro artifact builds', () => {
  beforeAll(async () => {
    for (const fixture of ['static', 'static-functions', 'mixed', 'server']) {
      await build({ root: `${join(fixtures, fixture)}/`, logLevel: 'silent' });
    }
  });

  it('emits an Object Storage-only static layout and manifest', async () => {
    const files = (await layout(join(fixtures, 'static/dist'))).map((file) => {
      if (!file.startsWith('client/_astro/logo.')) return file;
      return file.slice(file.lastIndexOf('/') + 1).includes('_')
        ? 'client/_astro/logo.optimized.svg'
        : 'client/_astro/logo.source.svg';
    });
    expect(files).toEqual([
      'client/_astro/logo.source.svg',
      'client/_astro/logo.optimized.svg',
      'client/about/index.html',
      'client/index.html',
      'client/robots.txt',
      'yandex-cloud.json',
    ]);
    expect(await manifest('static')).toMatchObject({
      schemaVersion: 1,
      target: 'object-storage',
      buildOutput: 'static',
      artifacts: { client: 'client' },
      routes: { prerendered: ['/', '/about/'], onDemand: [] },
    });
  });

  it('emits a mixed client/function layout and deployment metadata', async () => {
    const files = await layout(join(fixtures, 'mixed/dist'));
    expect(files).toContain('client/index.html');
    expect(files).toContain('client/public.txt');
    expect(files).toContain('function/index.js');
    expect(files).toContain('function/package.json');
    expect(files.some((file) => file.startsWith('function/chunks/'))).toBe(true);
    expect(await manifest('mixed')).toMatchObject({
      schemaVersion: 1,
      target: 'object-storage-functions',
      buildOutput: 'server',
      artifacts: { client: 'client', function: 'function' },
      function: { runtime: 'nodejs22', format: 'esm', entrypoint: 'index.handler' },
    });
  });

  it('omits a function when the functions target is fully static', async () => {
    const files = await layout(join(fixtures, 'static-functions/dist'));
    expect(files).not.toContain('function/index.js');
    expect(await manifest('static-functions')).toMatchObject({
      target: 'object-storage-functions',
      buildOutput: 'static',
      artifacts: { client: 'client' },
      routes: { onDemand: [] },
    });
  });

  it('executes the generated handler outside the fixture dependency tree', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'astro-yandex-function-'));
    await cp(join(fixtures, 'mixed/dist/function'), isolated, { recursive: true });
    const entrypoint = (await import(
      `${pathToFileURL(join(isolated, 'index.js')).href}?isolated=1`
    )) as {
      handler(
        event: object,
        context: object,
      ): Promise<{
        statusCode: number;
        body: string;
        isBase64Encoded: boolean;
        headers: Record<string, string>;
        multiValueHeaders: Record<string, string[]>;
      }>;
    };

    const response = await entrypoint.handler(
      {
        httpMethod: 'POST',
        path: '/api/echo',
        headers: {
          host: 'fixture.example',
          origin: 'https://fixture.example',
          'content-type': 'text/plain',
        },
        multiValueQueryStringParameters: { value: ['one', 'two'] },
        body: 'payload',
        requestContext: { identity: { sourceIp: '192.0.2.42' } },
      },
      { requestId: 'integration-request' },
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      body: 'payload',
      query: ['one', 'two'],
      requestId: 'integration-request',
    });

    const page = await entrypoint.handler(
      {
        httpMethod: 'GET',
        path: '/runtime',
        headers: { host: 'fixture.example' },
        requestContext: { identity: { sourceIp: '192.0.2.42' } },
      },
      { requestId: 'page-request' },
    );
    expect(page.body).toContain('page-request:192.0.2.42');
    expect(page.multiValueHeaders['set-cookie']).toContain('runtime=true; Path=/; HttpOnly');
    expect(page.headers['x-fixture-middleware']).toBe('runtime');

    const binary = await entrypoint.handler(
      { httpMethod: 'GET', path: '/api/binary', headers: { host: 'fixture.example' } },
      {},
    );
    expect(binary).toMatchObject({
      statusCode: 200,
      body: 'AAEC/w==',
      isBase64Encoded: true,
    });

    const error = await entrypoint.handler(
      { httpMethod: 'GET', path: '/api/error', headers: { host: 'fixture.example' } },
      {},
    );
    expect(error.statusCode).toBe(500);
  });

  it('supports all-server output', async () => {
    expect(await manifest('server')).toMatchObject({
      target: 'object-storage-functions',
      buildOutput: 'server',
      routes: { onDemand: ['/'] },
    });
  });

  it('rejects an Object Storage build containing an on-demand route', async () => {
    await expect(
      build({ root: `${join(fixtures, 'rejected')}/`, logLevel: 'silent' }),
    ).rejects.toThrow(/object-storage target cannot serve on-demand routes/);
  });

  it('builds and executes with the latest Astro 6 release', async () => {
    await execFileAsync('pnpm', ['build'], { cwd: join(fixtures, 'astro6') });
    const deployment = await manifest('astro6');
    expect(deployment.astro.version).toMatch(/^6\./);
    expect(deployment).toMatchObject({
      buildOutput: 'server',
      artifacts: { function: 'function' },
    });

    const entrypoint = (await import(
      `${pathToFileURL(join(fixtures, 'astro6/dist/function/index.js')).href}?astro6=1`
    )) as {
      handler(event: object, context: object): Promise<{ statusCode: number; body: string }>;
    };
    const response = await entrypoint.handler(
      { httpMethod: 'GET', path: '/runtime', headers: { host: 'astro6.example' } },
      { requestId: 'astro6-request' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Astro 6 runtime: astro6-request');
  });
});
