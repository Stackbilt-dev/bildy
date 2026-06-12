#!/usr/bin/env node
import { intro, outro, select, password, text, note, spinner, isCancel, cancel } from '@clack/prompts';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { realpathSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));
const GATEWAY_SCRIPT = resolve(__dirname, 'gateway.sh');
const ENV_FILE = resolve(__dirname, '.env');

const BANNER = `
\x1b[36m\x1b[1m  ██████╗ ██╗██╗      ██████╗ ██╗   ██╗\x1b[0m
\x1b[36m\x1b[1m  ██╔══██╗██║██║      ██╔══██╗╚██╗ ██╔╝\x1b[0m
\x1b[36m\x1b[1m  ██████╔╝██║██║      ██║  ██║ ╚████╔╝ \x1b[0m
\x1b[36m\x1b[1m  ██╔══██╗██║██║      ██║  ██║  ╚██╔╝  \x1b[0m
\x1b[36m\x1b[1m  ██████╔╝██║███████╗ ██████╔╝   ██║   \x1b[0m
\x1b[36m\x1b[1m  ╚═════╝ ╚═╝╚══════╝ ╚═════╝    ╚═╝   \x1b[0m
\x1b[2m  local-first LLM router\x1b[0m
`;

const PORT = process.env.BILDY_GATEWAY_PORT ?? '8787';
const KEY = process.env.BILDY_GATEWAY_KEY ?? 'local-dev-key';
const REMOTE_URL = process.env.BILDY_GATEWAY_URL;
const GATEWAY_URL = REMOTE_URL ?? `http://localhost:${PORT}`;
const IS_REMOTE = Boolean(REMOTE_URL);
const args = process.argv.slice(2);

function readEnvKey(key) {
  if (!existsSync(ENV_FILE)) return undefined;
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m && m[1] === key) return m[2].replace(/^"(.*)"$/, '$1');
  }
  return undefined;
}

function upsertEnv(key, value) {
  const entry = `${key}="${value}"`;
  if (!existsSync(ENV_FILE)) {
    writeFileSync(ENV_FILE, entry + '\n', 'utf8');
    return;
  }
  let content = readFileSync(ENV_FILE, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, entry);
  } else {
    content = content.endsWith('\n') ? content + entry + '\n' : content + '\n' + entry + '\n';
  }
  writeFileSync(ENV_FILE, content, 'utf8');
}

function isUp() {
  const r = spawnSync('curl', ['-sf', `${GATEWAY_URL}/health`], { timeout: 2000 });
  return r.status === 0;
}

function ensureUp() {
  spawnSync('bash', [GATEWAY_SCRIPT, '__ensure-up'], { stdio: 'inherit' });
}

async function runInit() {
  process.stdout.write(BANNER);
  intro('bildy init — gateway setup');

  const mode = await select({
    message: 'Where will this gateway run?',
    options: [
      { value: 'local', label: 'Local  — run the gateway on this machine' },
      { value: 'remote', label: 'Remote — point to an existing gateway URL' },
    ],
  });
  if (isCancel(mode)) { cancel(''); process.exit(0); }

  if (mode === 'remote') {
    const url = await text({
      message: 'Gateway URL:',
      placeholder: 'https://gateway.example.com',
      validate: (v) => (v.startsWith('http') ? undefined : 'Must start with http:// or https://'),
    });
    if (isCancel(url)) { cancel(''); process.exit(0); }
    upsertEnv('BILDY_GATEWAY_URL', url.trim());
    note(
      'Optional helper commands (claude-gw/codex-gw):\n  eval "$(bildy-gw shell-init)"',
      'next steps',
    );
    outro('Remote gateway saved. Run `bildy` to launch.');
    return;
  }

  // Local mode — collect at least one provider key
  const providers = [
    { key: 'GROQ_API_KEY',       label: 'Groq API key       (free tier, fast)' },
    { key: 'CEREBRAS_API_KEY',   label: 'Cerebras API key   (fast inference)' },
    { key: 'ANTHROPIC_API_KEY',  label: 'Anthropic API key  (Claude)' },
    { key: 'OPENAI_API_KEY',     label: 'OpenAI API key' },
  ];

  let anyConfigured = false;
  for (const p of providers) {
    const existing = readEnvKey(p.key) ?? process.env[p.key];
    if (existing) { anyConfigured = true; continue; }

    const val = await password({ message: `${p.label} — enter to skip:` });
    if (isCancel(val)) { cancel(''); process.exit(0); }
    if (val && val.trim()) {
      upsertEnv(p.key, val.trim());
      anyConfigured = true;
    }
  }

  if (!anyConfigured) {
    note('No API keys saved. Run `bildy init` again when you have at least one key.', 'warning');
    outro('Setup incomplete.');
    return;
  }

  note(
    'Optional: add claude-gw/codex-gw helper commands:\n  eval "$(bildy-gw shell-init)"\n\nThen launch with:\n  bildy',
    'next steps',
  );
  outro('Done. Run `bildy` to start.');
}

async function runPicker() {
  process.stdout.write(BANNER);

  const alive = IS_REMOTE || isUp();
  const statusTag = IS_REMOTE
    ? `\x1b[36m● remote\x1b[0m  ${GATEWAY_URL}`
    : `gateway ${alive ? '\x1b[32m● up\x1b[0m' : '\x1b[2m○ down\x1b[0m'}  :${PORT}`;
  intro(statusTag);

  const tool = await select({
    message: 'Launch with:',
    options: [
      { value: 'claude', label: 'Claude Code' },
      { value: 'codex', label: 'Codex' },
    ],
  });
  if (isCancel(tool)) { cancel(''); process.exit(0); }

  if (!IS_REMOTE && !alive) {
    const s = spinner();
    s.start('Starting gateway');
    ensureUp();
    s.stop('Gateway ready');
  }

  outro(`launching ${tool === 'claude' ? 'Claude Code' : 'Codex'}...`);

  const env = {
    ...process.env,
    ...(tool === 'claude'
      ? { ANTHROPIC_BASE_URL: GATEWAY_URL, ANTHROPIC_API_KEY: KEY }
      : { OPENAI_BASE_URL: `${GATEWAY_URL}/v1`, OPENAI_API_KEY: KEY, BILDY_GATEWAY_KEY: KEY }),
  };

  const result = spawnSync(tool, args, { stdio: 'inherit', env });
  process.exit(result.status ?? 0);
}

async function main() {
  if (args[0] === 'init') {
    await runInit();
  } else {
    await runPicker();
  }
}

main().catch((err) => {
  console.error(`\n[bildy] error: ${err.message}`);
  process.exit(1);
});
