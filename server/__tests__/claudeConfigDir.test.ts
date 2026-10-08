import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { getClaudeConfigDir } from '../src/providers/hook/claude/claudeConfigDir.js';

describe('getClaudeConfigDir', () => {
  const original = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
  });

  it('defaults to ~/.claude', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(getClaudeConfigDir()).toBe(path.join(os.homedir(), '.claude'));
  });

  it('follows CLAUDE_CONFIG_DIR, expanding a leading ~', () => {
    process.env.CLAUDE_CONFIG_DIR = '~/.claude_work';
    expect(getClaudeConfigDir()).toBe(path.join(os.homedir(), '.claude_work'));
    process.env.CLAUDE_CONFIG_DIR = '/opt/claude';
    expect(getClaudeConfigDir()).toBe(path.resolve('/opt/claude'));
  });

  it('ignores a blank override', () => {
    process.env.CLAUDE_CONFIG_DIR = '  ';
    expect(getClaudeConfigDir()).toBe(path.join(os.homedir(), '.claude'));
  });
});
