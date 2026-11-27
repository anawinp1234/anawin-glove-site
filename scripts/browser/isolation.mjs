// Process-level isolation for the browser suites.
//
// run-isolated.mjs starts a suite inside a bubblewrap sandbox; verifyIsolation() is what the suite and
// its mock server trust, not an environment flag. It proves from inside, before anything starts:
// - a separate network namespace whose only interface is lo, with no IPv4 routes and no
//   non-loopback IPv6 routes. This is checked passively from /proc; no connection is ever attempted
//   to anything but the run's own loopback listener;
// - a seccomp filter is installed (run-isolated.mjs's preflight proves it refuses AF_VSOCK);
// - WSL interop, /run, /mnt and the real home folder are not reachable, and HOME is the sandbox's own;
// - no socket descriptor was inherited.
// The exact guarantee and what it does not cover are in docs/purchase-regression-harness.md.
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { connect, createServer } from 'node:net';

// Socket descriptors above stdio as the process found them, before it opened anything of its own.
// (stdio itself may be a socketpair: that is how Node connects a child's pipes.)
const startupSockets = (() => { try { return readdirSync('/proc/self/fd').filter(fd => Number(fd) > 2).map(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return ''; } }).filter(target => target.startsWith('socket:')); } catch { return []; } })();

export const netnsOf = pid => { try { return readlinkSync(`/proc/${pid}/ns/net`); } catch { return null; } };

// Classic BPF for seccomp (x86-64): refuse foreign and x32 syscall ABIs, io_uring_setup (it can open
// sockets outside socket(2)), and socket(AF_VSOCK, ...), which network namespaces do not isolate and
// which on WSL 2 reaches the Windows host. Everything else is allowed.
export function seccompProgram() {
  const op = (code, jt, jf, k) => { const b = Buffer.alloc(8); b.writeUInt16LE(code, 0); b.writeUInt8(jt, 2); b.writeUInt8(jf, 3); b.writeUInt32LE(k >>> 0, 4); return b; };
  const LOAD = 0x20, JEQ = 0x15, JGE = 0x35, RET = 0x06, ALLOW = 0x7fff0000, ERRNO = errno => 0x00050000 | errno;
  const EPERM = 1, EAFNOSUPPORT = 97, AUDIT_ARCH_X86_64 = 0xc000003e, X32 = 0x40000000, IO_URING_SETUP = 425, SOCKET = 41, AF_VSOCK = 40;
  return Buffer.concat([
    op(LOAD, 0, 0, 4), op(JEQ, 1, 0, AUDIT_ARCH_X86_64), op(RET, 0, 0, ERRNO(EPERM)),
    op(LOAD, 0, 0, 0), op(JGE, 0, 1, X32), op(RET, 0, 0, ERRNO(EPERM)),
    op(JEQ, 0, 1, IO_URING_SETUP), op(RET, 0, 0, ERRNO(EPERM)),
    op(JEQ, 0, 3, SOCKET), op(LOAD, 0, 0, 16), op(JEQ, 0, 1, AF_VSOCK), op(RET, 0, 0, ERRNO(EAFNOSUPPORT)),
    op(RET, 0, 0, ALLOW)]);
}

const loopbackWorks = () => new Promise(resolve => {
  const server = createServer(socket => socket.end());
  server.once('error', () => resolve(false));
  server.listen(0, '127.0.0.1', () => {
    const socket = connect(server.address().port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); server.close(); resolve(true); });
    socket.once('error', () => { server.close(); resolve(false); });
  });
});
const entries = path => { try { return readdirSync(path); } catch { return []; } };

export async function verifyIsolation() {
  const reasons = [];
  const report = { platform: process.platform, netns: netnsOf('self'), parentNetns: process.env.ANAWIN_PARENT_NETNS || null };
  if (process.platform !== 'linux') reasons.push(`network namespaces need Linux (this is ${process.platform})`);
  else {
    if (!report.parentNetns) reasons.push('not started by run-isolated.mjs (ANAWIN_PARENT_NETNS is missing)');
    else if (report.parentNetns === report.netns) reasons.push('the network namespace is the same as the parent shell');
    report.interfaces = readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).map(row => row.split(':')[0].trim()).filter(Boolean);
    if (report.interfaces.join() !== 'lo') reasons.push(`interfaces other than lo exist: ${report.interfaces.join(', ')}`);
    report.ipv4Routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1).filter(Boolean).length;
    if (report.ipv4Routes) reasons.push(`${report.ipv4Routes} IPv4 routes exist`);
    const ipv6 = existsSync('/proc/net/ipv6_route') ? readFileSync('/proc/net/ipv6_route', 'utf8').trim().split('\n').filter(Boolean) : [];
    report.nonLoopbackIpv6Routes = ipv6.filter(row => row.trim().split(/\s+/).at(-1) !== 'lo').length;
    if (report.nonLoopbackIpv6Routes) reasons.push(`${report.nonLoopbackIpv6Routes} non-loopback IPv6 routes exist`);
    const status = readFileSync('/proc/self/status', 'utf8');
    report.seccomp = { mode: Number(/^Seccomp:\s+(\d+)/m.exec(status)?.[1]), filters: Number(/^Seccomp_filters:\s+(\d+)/m.exec(status)?.[1] ?? 0) };
    if (report.seccomp.mode !== 2 || report.seccomp.filters < 1) reasons.push('no seccomp filter is installed (AF_VSOCK would be reachable)');
    if (existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') && (existsSync('/run/WSL') || process.env.WSL_INTEROP)) {
      reasons.push('WSL interop is reachable, so Windows programs could run outside the namespace');
    }
    report.hidden = { run: entries('/run'), mnt: entries('/mnt'), home: entries('/home') };
    if (report.hidden.run.length || report.hidden.mnt.length) reasons.push(`host folders are visible: /run [${report.hidden.run}] /mnt [${report.hidden.mnt}]`);
    if (process.env.HOME !== '/tmp/home') reasons.push(`HOME is ${process.env.HOME}, not the sandbox's own`);
    report.inheritedSockets = startupSockets.length;
    if (startupSockets.length) reasons.push(`${startupSockets.length} socket descriptors were inherited`);
    try { report.sandbox = JSON.parse(process.env.ANAWIN_SANDBOX || 'null'); } catch { report.sandbox = null; }
    if (!report.sandbox) reasons.push('the sandbox profile is missing');
    report.loopback = await loopbackWorks();
    if (!report.loopback) reasons.push('loopback does not accept connections');
  }
  return { ok: !reasons.length, reasons, report };
}

export async function requireIsolation(label) {
  const result = await verifyIsolation();
  if (!result.ok) {
    console.error(`${label}: ISOLATION UNAVAILABLE. Refusing to start without the verified sandbox.\n  - ${result.reasons.join('\n  - ')}\n` +
      '  Run through scripts/browser/run-isolated.mjs (see docs/purchase-regression-harness.md, "Prerequisites").');
    process.exit(3);
  }
  return result.report;
}
