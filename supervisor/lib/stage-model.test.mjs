import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config/defaults.mjs';
import { NEEDS_SESSION } from '../config/transitions.mjs';
import { modelForStage } from './stage-model.mjs';
import { stageCommand } from './stage-command.mjs';
import { codexProbeCommand } from './provider.mjs';
import { checkCodexReadiness } from './codex-readiness.mjs';

const project = JSON.parse(readFileSync(new URL('../pipeline.config.json', import.meta.url)));
const home = fileURLToPath(new URL('..', import.meta.url));
const analysis = ['triage', 'interpret', 'postmortem'];
const execution = ['implement', 'revise', 'benchmark', 'deploy'];
const expected = {
  codex: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  claude: ['claude-fable-5-1', 'claude-opus-4-8', 'claude-opus-5'],
};
const modelFlag = (command) => command.args[command.args.indexOf('--model') + 1];

describe.each(['codex', 'claude'])('маршруты %s в реальном запуске', (provider) => {
  const config = resolveConfig({ ...project, provider }).config;
  it.each(NEEDS_SESSION)('%s получает свою модель и при resume', (stage) => {
    const model =
      expected[provider][analysis.includes(stage) ? 0 : execution.includes(stage) ? 1 : 2];
    const deployRoot =
      provider === 'codex' && stage === 'deploy'
        ? mkdtempSync(join(tmpdir(), 'td-stage-model-'))
        : null;
    try {
      if (deployRoot) {
        // Deploy проверяет существование пакетов и gitdir снимка ещё до выбора модели.
        const snapshot = join(deployRoot, '.pipeline', 'deploy-checkouts', 'deploy-test');
        const gitdir = join(deployRoot, '.git', 'worktrees', 'deploy-test');
        mkdirSync(gitdir, { recursive: true });
        for (const group of ['apps', 'packages']) {
          const packageDir = join(snapshot, group, 'sample');
          mkdirSync(packageDir, { recursive: true });
          writeFileSync(join(packageDir, 'package.json'), '{}');
        }
        writeFileSync(join(snapshot, '.git'), `gitdir: ${gitdir}`);
      }
      for (const continuation of [false, true]) {
        const command = stageCommand({
          assignment: {
            stage,
            continuation,
            sessionId: 'session-1',
            ...(deployRoot ? { path: '.pipeline/deploy-checkouts/deploy-test' } : {}),
          },
          config,
          root: deployRoot ?? '/repo',
          home,
          prompt: 'назначение',
        });
        expect(modelFlag(command)).toBe(model);
        expect(command.args.filter((arg) => arg === '--model')).toHaveLength(1);
        expect(command.args.includes('--resume') || command.args.includes('resume')).toBe(
          continuation,
        );
      }
    } finally {
      if (deployRoot) rmSync(deployRoot, { recursive: true, force: true });
    }
  });

  it('новый этап получает default; чужой провайдер и общая модель не влияют', () => {
    const configured = { ...config, stageModel: 'old-claude', codexModel: 'old-codex' };
    expect(modelForStage(configured, provider, 'future-stage')).toBe(expected[provider][2]);
    expect(modelForStage(configured, provider, 'deploy')).toBe(expected[provider][1]);
    const legacy = { stageModel: 'old-claude', codexModel: 'old-codex' };
    expect(modelForStage(legacy, provider, 'deploy')).toBe(`old-${provider}`);
    expect(
      modelForStage(
        { ...legacy, stageModels: { [provider]: { triage: 'special' } } },
        provider,
        'deploy',
      ),
    ).toBe(`old-${provider}`);
    expect(modelForStage({}, provider, 'deploy')).toBeUndefined();
  });
});

it('проба сервера Codex использует Sol', () => {
  expect(modelFlag(codexProbeCommand(resolveConfig(project).config))).toBe('gpt-5.6-sol');
  expect(resolveConfig(project).config.apiProbeModel).toBe('claude-opus-5');
});

it.each(['win32', 'linux'])(
  'проверка готовности выкладки Codex использует Terra: %s',
  async (platform) => {
    const launched = [];
    const root = mkdtempSync(join(tmpdir(), 'td-stage-model-readiness-'));
    try {
      await checkCodexReadiness({
        platform,
        config: resolveConfig(project).config,
        root,
        env: { GH_TOKEN: 'test-token' },
        start: ({ command }) => {
          launched.push(command);
          if (command.args.includes('sandbox'))
            return { finished: Promise.resolve({ code: 0, stdout: 'td-workspace-ready' }) };
          return { finished: Promise.resolve({ code: 1, stdout: '' }) };
        },
      });
    } finally {
      if (platform === 'win32') rmdirSync(join(root, '.pipeline'));
      rmdirSync(root);
    }
    expect(
      launched.map((command) => command.args.find((arg) => arg === 'sandbox' || arg === 'exec')),
    ).toEqual(platform === 'win32' ? ['sandbox', 'exec'] : ['exec']);
    for (const command of launched.filter((command) => command.args.includes('sandbox')))
      expect(command.args).not.toContain('--model');
    const probes = launched.filter((command) => command.args.includes('exec'));
    expect(probes).toHaveLength(1);
    expect(probes[0].args.filter((arg) => arg === '--model')).toHaveLength(1);
    expect(modelFlag(probes[0])).toBe('gpt-5.6-terra');
  },
);
