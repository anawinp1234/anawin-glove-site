// Runs a browser suite inside a least-privilege bubblewrap sandbox (see isolation.mjs for what is proven
// from inside, and docs/purchase-regression-harness.md for the exact guarantee).
//   node scripts/browser/run-isolated.mjs scripts/browser/purchase-regression-browser.mjs
//
// The sandbox has its own network (loopback only), PID, IPC and UTS namespaces; a read-only root;
// empty /tmp, /run, /mnt and /home with only the repo, Node, Chrome and the declared support folders
// bound back (read-only) and the evidence folders bound writable; a fresh HOME; an allowlisted
// environment; no inherited descriptors beyond stdio; and a seccomp filter that refuses AF_VSOCK
// sockets, io_uring and non-native syscall ABIs. Executables are resolved to real paths, never via
// PATH. Anything that cannot be set up or verified exits 3 without running the suite; there is no
// fallback to the normal environment.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { netnsOf, seccompProgram } from './isolation.mjs';

const refuse = message => { console.error(`run-isolated: ISOLATION UNAVAILABLE. ${message}`); process.exit(3); };
const [script, ...args] = process.argv.slice(2);
if (!script) refuse('Usage: node scripts/browser/run-isolated.mjs <suite.mjs> [args]');
if (process.platform !== 'linux' || process.arch !== 'x64') refuse(`Needs Linux on x86-64; this is ${process.platform}/${process.arch}. Use a Linux machine, WSL 2 or a Linux container.`);

// Root-owned, not writable by anyone else: an executable the user's own processes cannot replace.
const trusted = (candidates, what) => {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const path = realpathSync(candidate);
    const info = statSync(path);
    if (info.isFile() && info.uid === 0 && !(info.mode & 0o022)) return path;
  }
  return refuse(`${what} was not found as a root-owned executable at ${candidates.join(' or ')}. ${what === 'bubblewrap' ? 'Install it, e.g. `sudo apt install bubblewrap`.' : 'Install it from the system package manager.'}`);
};
const bwrap = trusted(['/usr/bin/bwrap', '/bin/bwrap'], 'bubblewrap');
const python = trusted(['/usr/bin/python3', '/bin/python3'], 'python3');
if (spawnSync(bwrap, ['--version']).status !== 0) refuse('bubblewrap does not run.');

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const node = realpathSync(process.execPath);
const nodeRoot = dirname(dirname(node));
const suite = realpathSync(resolve(script));
const executable = (value, what) => {
  if (!value) return refuse(`${what} is not set.`);
  const path = realpathSync(value);
  if (/\.exe$/i.test(path) || path.startsWith('/mnt/')) refuse(`${what} resolves to ${path}, a Windows program that would run outside the sandbox.`);
  if (!statSync(path).isFile()) refuse(`${what} (${path}) is not a file.`);
  try { accessSync(path, constants.X_OK); } catch { refuse(`${what} (${path}) is not executable.`); }
  return path;
};
const chrome = executable(process.env.ANAWIN_CHROME, 'ANAWIN_CHROME');
const folders = list => (list || '').split(':').filter(Boolean).map(path => {
  if (!isAbsolute(path) || !existsSync(path)) refuse(`${path} must be an existing absolute path.`);
  return realpathSync(path);
});
const libraries = folders(process.env.LD_LIBRARY_PATH);
const fontconfig = process.env.FONTCONFIG_FILE ? realpathSync(process.env.FONTCONFIG_FILE) : null;
// Font folders the fontconfig file names, so the fonts it adds are visible read-only.
const fontFolders = fontconfig ? [dirname(fontconfig), ...[...readFileSync(fontconfig, 'utf8').matchAll(/<dir>([^<]+)<\/dir>/g)].map(match => match[1].trim())
  .filter(path => isAbsolute(path) && existsSync(path)).map(path => realpathSync(path))] : [];

// Evidence is the only writable host content, plus Vite's dependency cache inside node_modules.
const evidenceDefaults = { ANAWIN_PURCHASE_EVIDENCE_DIR: 'anawin-purchase-regression-evidence', ANAWIN_BREAK_IN_EVIDENCE_DIR: 'anawin-break-in-evidence',
  ANAWIN_CART_EVIDENCE_DIR: 'anawin-cart-break-in-evidence' };
const evidence = Object.fromEntries(Object.entries(evidenceDefaults).map(([name, folder]) => {
  const path = process.env[name] || join(tmpdir(), folder);
  mkdirSync(path, { recursive: true });
  return [name, realpathSync(path)];
}));
const viteCache = join(repo, 'node_modules/.vite');
mkdirSync(viteCache, { recursive: true });

// Source facts are read here: the sandbox cannot see the shared Git directory.
const git = argv => { try { return execFileSync('git', argv, { cwd: repo, encoding: 'utf8' }).trim(); } catch { return null; } };
const env = {
  PATH: `${dirname(node)}:/usr/bin:/bin`, HOME: '/tmp/home', TMPDIR: '/tmp', LANG: 'C.UTF-8', TZ: 'UTC',
  ANAWIN_CHROME: chrome, ...evidence, ANAWIN_PARENT_NETNS: netnsOf('self'),
  ANAWIN_SOURCE_REVISION: git(['rev-parse', 'HEAD']) || '', ANAWIN_SOURCE_STATUS: JSON.stringify((git(['status', '--porcelain']) || '').split('\n').filter(Boolean)),
  ...(libraries.length ? { LD_LIBRARY_PATH: libraries.join(':') } : {}), ...(fontconfig ? { FONTCONFIG_FILE: fontconfig } : {}),
  ...(process.env.ANAWIN_PURCHASE_ONLY ? { ANAWIN_PURCHASE_ONLY: process.env.ANAWIN_PURCHASE_ONLY } : {})
};
const readOnly = [...new Set([repo, nodeRoot, dirname(chrome), dirname(suite), ...libraries, ...fontFolders])];
const mounts = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', '/mnt', '--tmpfs', '/home',
  ...(existsSync('/root') ? ['--tmpfs', '/root'] : []), ...(existsSync('/media') ? ['--tmpfs', '/media'] : []),
  ...readOnly.flatMap(path => ['--ro-bind', path, path]), '--bind', viteCache, viteCache,
  ...Object.values(evidence).flatMap(path => ['--bind', path, path]), '--dir', '/tmp/home'];
const sandbox = [...mounts, '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
  '--clearenv', ...Object.entries(env).flatMap(([name, value]) => ['--setenv', name, value]), '--chdir', repo];
env.ANAWIN_SANDBOX = JSON.stringify({ bwrap, readOnly, writable: [viteCache, ...Object.values(evidence)], hidden: ['/tmp', '/run', '/mnt', '/home', '/root', '/media'] });
sandbox.push('--setenv', 'ANAWIN_SANDBOX', env.ANAWIN_SANDBOX);

const run = (command, commandArgs, stdio) => {
  const child = spawn(bwrap, ['--seccomp', '4', '--json-status-fd', '3', ...sandbox, '--', command, ...commandArgs],
    { env: {}, stdio: ['ignore', stdio, 'inherit', 'pipe', 'pipe'] });
  child.stdio[4].end(seccompProgram());
  let status = '';
  child.stdio[3].on('data', chunk => { status += chunk; });
  child.on('error', error => refuse(`bwrap could not start: ${error.message}`));
  return { child, started: () => /"child-pid"/.test(status) };
};

// Preflight in an identical sandbox: AF_VSOCK refused, no reachable socket files, no extra descriptors.
const PREFLIGHT = `
import json, os, socket
out = {}
try:
    socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); out['vsock'] = 'open'
except OSError as error:
    out['vsock'] = error.errno
found = []
for root, dirs, files in os.walk('/', topdown=True, onerror=None, followlinks=False):
    if root in ('/proc', '/sys', '/dev'): dirs[:] = []; continue
    for name in files:
        path = os.path.join(root, name)
        try:
            if os.path.stat.S_ISSOCK(os.lstat(path).st_mode): found.append(path)
        except OSError: pass
    if len(found) > 20: break
out['sockets'] = found
out['fds'] = sorted(int(fd) for fd in os.listdir('/proc/self/fd'))
print(json.dumps(out))`;
const preflight = run(python, ['-I', '-c', PREFLIGHT], 'pipe');
let probe = '';
preflight.child.stdout.on('data', chunk => { probe += chunk; });
const preflightCode = await new Promise(done => preflight.child.on('close', done));
if (!preflight.started()) refuse(`bwrap could not create the sandbox (exit ${preflightCode}). Unprivileged user namespaces may be disabled or restricted by AppArmor.`);
let facts;
try { facts = JSON.parse(probe.trim().split('\n').at(-1)); } catch { refuse(`sandbox preflight produced no result (exit ${preflightCode}).`); }
// 97 is EAFNOSUPPORT, the errno the seccomp filter returns; os.listdir itself holds one descriptor.
if (facts.vsock !== 97) refuse(`AF_VSOCK is not refused inside the sandbox (${facts.vsock}).`);
if (facts.sockets.length) refuse(`host socket files are reachable inside the sandbox: ${facts.sockets.join(', ')}`);
if (facts.fds.some(fd => fd > 3)) refuse(`unexpected inherited descriptors inside the sandbox: ${facts.fds.join(', ')}`);

const main = run(node, [suite, ...args], 'inherit');
main.child.stdio[3].on('end', () => {});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => main.child.kill(signal));
main.child.on('close', (code, signal) => {
  if (!main.started()) refuse(`bwrap could not create the sandbox (exit ${code ?? signal}).`);
  process.exit(code ?? 1);
});
