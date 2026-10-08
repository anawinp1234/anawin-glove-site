import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(scriptPath);
const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: scriptDirectory,
  encoding: 'utf8',
}).trim();
const sourceRoot = path.join(repositoryRoot, 'src');
const sourceExtensions = ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.json', '.css'];
const importPattern = /\b(?:from\s*|import\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
const problems = [];

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.(?:js|mjs|ts|tsx|jsx)$/.test(entry.name) ? [entryPath] : [];
  });
}

function resolveImport(importer, specifier) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const target = path.resolve(path.dirname(importer), cleanSpecifier);
  const candidates = path.extname(target)
    ? [target]
    : [target, ...sourceExtensions.map(extension => `${target}${extension}`), ...sourceExtensions.map(extension => path.join(target, `index${extension}`))];
  return candidates.find(candidate => existsSync(candidate));
}

for (const importer of sourceFiles(sourceRoot)) {
  const source = readFileSync(importer, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const [, specifier] = match;
    const target = resolveImport(importer, specifier);
    const importerRelative = path.relative(repositoryRoot, importer);
    if (!target) {
      problems.push(`${importerRelative} imports missing ${specifier}`);
      continue;
    }

    const targetRelative = path.relative(repositoryRoot, target);
    try {
      execFileSync('git', ['ls-files', '--error-unmatch', '--', targetRelative], {
        cwd: repositoryRoot,
        stdio: 'ignore',
      });
    } catch {
      problems.push(`${importerRelative} imports untracked ${targetRelative}`);
    }
  }
}

if (problems.length) {
  console.error('Source import check failed:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log('All relative source imports resolve to Git-tracked files.');
}
