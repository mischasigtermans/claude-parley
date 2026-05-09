import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { paths } from '../registry/paths.js';
import { isErrnoException } from '../util/errors.js';

export async function appendTurn(
  alias: string,
  fromProject: string,
  question: string,
  answer: string,
  via: 'live' | 'headless-resumed' | 'headless-fresh',
): Promise<void> {
  await mkdir(paths.logsDir, { recursive: true });
  const ts = new Date().toISOString();
  const block =
    `## ${ts} · from ${fromProject} (${via})\n\n` +
    `**Q:** ${question}\n\n` +
    `**A:**\n\n${answer}\n\n---\n\n`;
  await appendFile(paths.logFor(alias), block, 'utf8');
}

export async function readTranscript(alias: string, tail: number): Promise<string> {
  try {
    const content = await readFile(paths.logFor(alias), 'utf8');
    if (tail <= 0) return content;
    const blocks = content.split(/^---\s*$/m).filter((b) => b.trim().length > 0);
    return blocks.slice(-tail).join('---\n').trim();
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return '';
    throw err;
  }
}
